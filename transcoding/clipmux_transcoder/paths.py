"""
Path policy for agent-side file access.

The agent reads files on a machine the owner also uses, which makes path handling
the highest-severity surface in the whole feature. Three classes of escape are
handled here, each of which has a naive implementation that looks correct:

1. **Traversal** — ``../../etc/shadow``. Blocked by resolving the *candidate*
   and checking containment against the *resolved* root.
2. **Symlink escape** — a file inside a configured root that links outside it.
   ``resolve()`` follows links, so containment is checked on the final target,
   not on the path string. A root is itself resolved first, so a root that is
   itself a symlink still works.
3. **Special files** — FIFOs, sockets and device nodes. Opening a FIFO blocks
   forever; a device node can be enormous or destructive. Only regular files
   are accepted.

Every rejection carries a typed reason so the dashboard can say *why* a file
cannot be imported instead of returning an opaque failure.
"""
from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence


class PathRejected(Exception):
    """A path failed the policy. ``reason`` is a stable machine-readable code."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


REASON_OUTSIDE_ROOTS = "OUTSIDE_ROOTS"
REASON_NOT_FOUND = "NOT_FOUND"
REASON_NOT_A_FILE = "NOT_A_FILE"
REASON_NOT_A_DIRECTORY = "NOT_A_DIRECTORY"
REASON_UNREADABLE = "UNREADABLE"
REASON_INVALID = "INVALID_PATH"


@dataclass(frozen=True)
class Root:
    """One configured readable location, with the display name owners see."""
    name: str
    path: Path

    @property
    def resolved(self) -> Path:
        return Path(os.path.realpath(self.path))


class PathPolicy:
    """Resolves and validates source paths against the configured roots."""

    def __init__(self, roots: Sequence[Root]):
        if not roots:
            raise ValueError("at least one root is required")
        self._roots: List[Root] = list(roots)

    @property
    def roots(self) -> List[Root]:
        return list(self._roots)

    def root_named(self, name: str) -> Optional[Root]:
        return next((root for root in self._roots if root.name == name), None)

    def resolve(self, candidate: str | Path, *, must_exist: bool = True) -> Path:
        """
        Resolve ``candidate`` to a real regular file inside one of the roots.

        Raises :class:`PathRejected` with a typed reason otherwise.
        """
        return self._resolve(candidate, must_exist=must_exist, expect="file")

    def resolve_directory(self, candidate: str | Path, *, must_exist: bool = True) -> Path:
        """Resolve a directory. Containment rules are identical to files."""
        return self._resolve(candidate, must_exist=must_exist, expect="directory")

    def _resolve(self, candidate: str | Path, *, must_exist: bool, expect: str) -> Path:
        if candidate is None or str(candidate).strip() == "":
            raise PathRejected(REASON_INVALID, "empty path")

        raw = str(candidate)
        if "\x00" in raw:
            raise PathRejected(REASON_INVALID, "path contains a NUL byte")

        path = Path(raw)
        if not path.is_absolute():
            raise PathRejected(
                REASON_INVALID,
                "path must be absolute and start from a configured root",
            )

        # `realpath` follows every link, so containment is checked on the final
        # target rather than on the path string. A root that is itself a symlink
        # still works because roots are resolved the same way.
        resolved = Path(os.path.realpath(path))

        root = self._containing_root(resolved)
        if root is None:
            raise PathRejected(
                REASON_OUTSIDE_ROOTS,
                "path is not inside any folder this agent can read",
            )

        if not resolved.exists():
            if must_exist:
                raise PathRejected(REASON_NOT_FOUND, "file does not exist")
            return resolved

        try:
            info = resolved.stat()
        except OSError as exc:
            raise PathRejected(REASON_UNREADABLE, f"cannot stat path: {exc}") from exc

        if expect == "file":
            if not stat.S_ISREG(info.st_mode):
                raise PathRejected(
                    REASON_NOT_A_FILE,
                    "only regular files can be imported "
                    "(not directories, FIFOs or devices)",
                )
            if not os.access(resolved, os.R_OK):
                raise PathRejected(
                    REASON_UNREADABLE, "file is not readable by the agent user"
                )
        elif not stat.S_ISDIR(info.st_mode):
            raise PathRejected(REASON_NOT_A_DIRECTORY, "path is not a directory")

        return resolved

    def display_path(self, resolved: Path) -> str:
        """
        Root-relative path for display.

        Absolute host paths are never exposed to the browser, so the dashboard
        shows ``course/lesson-01.mp4`` under a named root rather than
        ``/srv/media/course/lesson-01.mp4``. The former is enough for an owner to
        recognise their own file.
        """
        for root in self._roots:
            try:
                return resolved.relative_to(root.resolved).as_posix()
            except ValueError:
                continue
        return resolved.name

    def _containing_root(self, resolved: Path) -> Optional[Root]:
        for root in self._roots:
            base = root.resolved
            if resolved == base or base in resolved.parents:
                return root
        return None

    def list_directory(
        self,
        directory: str | Path,
        *,
        limit: int = 200,
        cursor: str = "",
        include_hidden: bool = False,
    ) -> "DirectoryListing":
        """
        List one directory for the dashboard browser.

        Paginated and root-relative. Entries whose target escapes the roots are
        omitted rather than merely refused on selection, so the browser cannot
        even show something it would refuse to import.
        """
        resolved = self.resolve_directory(directory)

        try:
            names = sorted(os.listdir(resolved))
        except OSError as exc:
            raise PathRejected(REASON_UNREADABLE, f"cannot list directory: {exc}") from exc

        if cursor:
            names = [name for name in names if name > cursor]

        entries: List[DirectoryEntry] = []
        for name in names:
            if not include_hidden and name.startswith("."):
                continue
            entry_path = resolved / name
            try:
                is_dir = entry_path.is_dir()
                if not is_dir:
                    # Symlinked files are shown only if their target is readable
                    # and inside a root — the same rule selection enforces.
                    target = Path(os.path.realpath(entry_path))
                    if self._containing_root(target) is None:
                        continue
                    info = target.stat()
                    if not stat.S_ISREG(info.st_mode):
                        continue
                else:
                    if self._containing_root(Path(os.path.realpath(entry_path))) is None:
                        continue
            except OSError:
                continue

            entry = DirectoryEntry.from_path(entry_path, self)
            entries.append(entry)
            if len(entries) >= limit:
                break

        next_cursor = entries[-1].name if len(entries) >= limit else ""
        return DirectoryListing(
            root=self.root_for(resolved),
            path=self.display_path(resolved),
            entries=entries,
            next_cursor=next_cursor,
        )

    def root_for(self, resolved: Path) -> str:
        root = self._containing_root(resolved)
        return root.name if root else ""


@dataclass
class DirectoryEntry:
    """One row in the folder browser. Never carries an absolute host path."""
    name: str
    path: str
    is_directory: bool
    size: int = 0
    modified_at: float = 0.0
    media_type: str = ""
    identity: str = ""

    @classmethod
    def from_path(cls, path: Path, policy: PathPolicy) -> "DirectoryEntry":
        is_dir = path.is_dir()
        size = 0
        modified = 0.0
        identity = ""
        if not is_dir:
            try:
                resolved = Path(os.path.realpath(path))
                info = resolved.stat()
                size = info.st_size
                modified = info.st_mtime
                identity = file_identity(resolved)
            except OSError:
                pass
        return cls(
            name=path.name,
            path=policy.display_path(path),
            is_directory=is_dir,
            size=size,
            modified_at=modified,
            media_type=guess_media_type(path.name),
            identity=identity,
        )

    def as_payload(self) -> dict:
        return {
            "name": self.name,
            "path": self.path,
            "isDirectory": self.is_directory,
            "size": self.size,
            "modifiedAt": int(self.modified_at),
            "mediaType": self.media_type,
            "identity": self.identity,
        }


@dataclass
class DirectoryListing:
    root: str
    path: str
    entries: List[DirectoryEntry]
    next_cursor: str = ""

    def as_payload(self) -> dict:
        return {
            "root": self.root,
            "path": self.path,
            "entries": [entry.as_payload() for entry in self.entries],
            "nextCursor": self.next_cursor,
        }


# Extensions the browser will *offer* for import. Listing is not filtered by
# this — an owner can see their whole folder — but the UI marks media so the
# common case is one click.
MEDIA_EXTENSIONS = frozenset({
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg",
    ".ts", ".m2ts", ".flv", ".wmv", ".ogv", ".mp3", ".m4a", ".aac",
    ".flac", ".wav", ".ogg", ".opus",
})


def guess_media_type(name: str) -> str:
    suffix = Path(name).suffix.lower()
    if suffix in MEDIA_EXTENSIONS:
        return "video" if suffix not in (".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus") else "audio"
    return ""


def file_identity(path: Path) -> str:
    """
    Cheap, stable identity for a file: device, inode, size, mtime.

    This is what detects "the original moved or changed" without hashing a
    multi-gigabyte file twice. It is not a content hash and is not used as one —
    the snapshot's SHA-256 is.
    """
    try:
        info = path.stat()
    except OSError:
        return ""
    return f"{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}"


def iter_files(directory: Path, policy: PathPolicy) -> Iterable[Path]:
    """Walk a directory, yielding only policy-approved regular files."""
    for base, _dirs, names in os.walk(directory):
        for name in names:
            candidate = Path(base) / name
            try:
                yield policy.resolve(candidate)
            except PathRejected:
                continue
