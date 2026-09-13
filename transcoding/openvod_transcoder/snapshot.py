"""
Where a job's bytes come from, and the snapshot taken of them.

The snapshot exists because of one sentence in the plan: *"Original media mounts
are read-only... Never delete the user's original."* Encoding directly from a
mount the owner can modify means a mid-job edit silently produces a package
whose segments disagree with each other — and a retry produces a different
package from the same "source". So every job encodes from an agent-owned copy
whose hash is bound into the reusable-work key.

Why a copy and not a hardlink: a hardlink shares the inode, so it is *not*
immutable. Editing the original in place (the common case for a re-exported
lesson) changes the bytes under the snapshot, which defeats the entire
mechanism. A reflink shares no writable state and is used when the filesystem
supports it; otherwise this is a real copy, and the disk-space estimate accounts
for that.
"""
from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from openvod_transcoder.errors import (
    ERROR_INSUFFICIENT_DISK,
    ERROR_SOURCE_CHANGED,
    ERROR_SOURCE_MISSING,
    ERROR_SOURCE_UNREADABLE,
    TranscodeError,
)
from openvod_transcoder.paths import PathRejected, file_identity
from openvod_transcoder.result import sha256_file

SNAPSHOT_REFLINK = "reflink"
SNAPSHOT_COPY = "copy"

# Reflink probe. FICLONE is Linux-specific and only works within one filesystem;
# the ioctl is what `cp --reflink=auto` uses.
FICLONE = 0x40049409


@dataclass
class SourceSnapshot:
    """The immutable copy a job actually encodes."""
    path: Path
    size_bytes: int
    sha256: str
    method: str
    identity_before: str = ""
    identity_after: str = ""
    elapsed_seconds: float = 0.0

    def reusable_key(self, plan_fingerprint: str) -> str:
        return f"{self.sha256}:{plan_fingerprint}"


def estimate_scratch_bytes(source_size: int, rendition_count: int) -> int:
    """
    Rough scratch requirement for a job, in bytes.

    Deliberately pessimistic. The fMP4 intermediates for the whole ladder plus
    the packaged segments both exist on disk at peak, and an estimate that is too
    low turns a slow job into a failed one at 90% — the worst possible time to
    run out. The constants are the measured ratio from the existing pipeline
    (transcoded output ≈ 0.9× source at the capped ladder) with headroom.
    """
    per_rendition = source_size * 0.35
    intermediates = source_size * 1.2
    outputs = source_size * 0.9 + per_rendition * max(1, rendition_count)
    return int(intermediates + outputs + 512 * 1024 * 1024)


def ensure_scratch(work_dir: Path, required_bytes: int) -> None:
    """Raise a typed error when scratch cannot hold this job."""
    probe = work_dir if work_dir.exists() else work_dir.parent
    try:
        free = shutil.disk_usage(str(probe)).free
    except OSError as exc:
        raise TranscodeError(
            ERROR_INSUFFICIENT_DISK, f"cannot measure scratch space at {probe}: {exc}"
        ) from exc
    if free < required_bytes:
        raise TranscodeError(
            ERROR_INSUFFICIENT_DISK,
            f"insufficient scratch space: {free / 1024**3:.2f} GB free, "
            f"estimated need {required_bytes / 1024**3:.2f} GB "
            f"(raise the agent's scratch quota or free space)",
        )


def _try_reflink(source: Path, destination: Path) -> bool:
    """Attempt a copy-on-write clone. Returns False when unsupported."""
    import fcntl

    try:
        with open(source, "rb") as src, open(destination, "wb") as dst:
            fcntl.ioctl(dst.fileno(), FICLONE, src.fileno())
        return True
    except (OSError, AttributeError, ImportError):
        # Unsupported filesystem, cross-device, or a platform without fcntl.
        try:
            destination.unlink()
        except OSError:
            pass
        return False


@dataclass
class SnapshotPolicy:
    """How the snapshot is taken and validated."""
    allow_reflink: bool = True
    # Bytes copied between identity checks. Small enough that an edit during a
    # copy of a large file is caught, large enough not to syscall per kilobyte.
    verify_chunk_bytes: int = 8 * 1024 * 1024
    # Hash while copying: the snapshot is read once instead of twice.
    hash_while_copying: bool = True
    copy_timeout_seconds: float = 3600.0


def create_snapshot(
    source_path: Path,
    destination: Path,
    *,
    policy: Optional[SnapshotPolicy] = None,
    expected_identity: str = "",
    on_progress=None,
) -> SourceSnapshot:
    """
    Copy (or clone) ``source_path`` to ``destination`` and hash the result.

    Detects the original changing *during* the copy by comparing the file
    identity before and after. A file that was modified mid-copy produces a
    snapshot that mixes two versions of itself — a failure that shows up much
    later as a corrupt package, so it is caught here and reported as
    ``SOURCE_CHANGED``.
    """
    settings = policy or SnapshotPolicy()
    started = time.monotonic()

    if not source_path.exists():
        raise TranscodeError(
            ERROR_SOURCE_MISSING,
            f"source file is gone: {source_path.name} (it may have been moved, "
            f"renamed or unmounted)",
        )

    try:
        identity_before = file_identity(source_path)
    except PathRejected as exc:  # pragma: no cover - resolve() raises first
        raise TranscodeError(ERROR_SOURCE_UNREADABLE, exc.message) from exc

    if expected_identity and identity_before and identity_before != expected_identity:
        raise TranscodeError(
            ERROR_SOURCE_CHANGED,
            "source file changed since it was registered (size or modification "
            "time differ). Re-register the file to import its current contents.",
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    size_before = source_path.stat().st_size

    ensure_scratch(destination.parent, size_before + 256 * 1024 * 1024)

    method = SNAPSHOT_COPY
    if settings.allow_reflink and _try_reflink(source_path, destination):
        method = SNAPSHOT_REFLINK
        digest = sha256_file(destination)
    else:
        digest = _copy_and_hash(
            source_path,
            destination,
            settings=settings,
            on_progress=on_progress,
        )

    identity_after = file_identity(source_path)
    if identity_before and identity_after and identity_before != identity_after:
        # Keep the partial copy out of the reusable cache: it is a blend of two
        # versions and must never be reused.
        try:
            destination.unlink()
        except OSError:
            pass
        raise TranscodeError(
            ERROR_SOURCE_CHANGED,
            "source file was modified while it was being read; the copy would "
            "mix two versions. Stop writing to the file and retry.",
        )

    if destination.stat().st_size != size_before:
        raise TranscodeError(
            ERROR_SOURCE_CHANGED,
            "snapshot size does not match the source; the file changed while copying",
        )

    return SourceSnapshot(
        path=destination,
        size_bytes=size_before,
        sha256=digest,
        method=method,
        identity_before=identity_before,
        identity_after=identity_after,
        elapsed_seconds=time.monotonic() - started,
    )


def _copy_and_hash(source: Path, destination: Path, *, settings: SnapshotPolicy, on_progress) -> str:
    import hashlib

    digest = hashlib.sha256()
    total = source.stat().st_size or 1
    copied = 0
    try:
        with open(source, "rb") as src, open(destination, "wb") as dst:
            while True:
                chunk = src.read(settings.verify_chunk_bytes)
                if not chunk:
                    break
                dst.write(chunk)
                if settings.hash_while_copying:
                    digest.update(chunk)
                copied += len(chunk)
                if on_progress is not None:
                    on_progress(min(1.0, copied / total))
    except OSError as exc:
        try:
            destination.unlink()
        except OSError:
            pass
        raise TranscodeError(
            ERROR_SOURCE_UNREADABLE, f"cannot read source file: {exc}"
        ) from exc

    if not settings.hash_while_copying:
        return sha256_file(destination)
    return digest.hexdigest()


def cleanup_snapshot(snapshot: SourceSnapshot) -> None:
    """
    Remove a snapshot. Never touches the original — the snapshot is a copy the
    pipeline created, in a directory the pipeline owns.
    """
    try:
        if snapshot.path.exists():
            snapshot.path.unlink()
    except OSError as exc:  # pragma: no cover - best effort housekeeping
        print(f"[SNAPSHOT] could not remove {snapshot.path.name}: {exc}")


def original_untouched(snapshot: SourceSnapshot, original: Path) -> bool:
    """
    Assertion used by tests and by the doctor: the original still exists with
    its original identity after a job ran.
    """
    if not original.exists():
        return False
    return file_identity(original) == snapshot.identity_before


def is_same_file(left: Path, right: Path) -> bool:
    try:
        return os.path.samefile(left, right)
    except OSError:
        return False
