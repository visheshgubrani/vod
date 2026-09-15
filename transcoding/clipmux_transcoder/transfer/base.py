"""
Transfer seam: how finished artifacts leave the machine doing the encoding.

Two implementations, chosen by the caller rather than by the engine:

- :mod:`clipmux_transcoder.transfer.s3` — the existing Modal path, where the
  worker holds short-lived R2 credentials from a Modal secret.
- :mod:`clipmux_transcoder.transfer.signed` — the self-hosted path, where the
  API hands out bounded, short-lived presigned URLs and the agent never sees a
  permanent storage credential.

Both are described by :class:`ArtifactTransfer` so the pipeline does not branch
on which one it has. The protocol only ever talks about *artifact paths relative
to the packaged output directory*: absolute local paths and bucket credentials
are implementation details of the transport, which keeps the "restrict uploads
to inventory-listed paths inside the attempt prefix" rule enforceable in one
place.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Protocol, Tuple


# Content-Type and Cache-Control per extension. Playlists are short-lived (they
# are rewritten on redeploy and must not be pinned by a CDN); segments and
# images are immutable because their names change whenever their bytes do.
CONTENT_TYPES: Dict[str, Tuple[str, str]] = {
    ".m3u8": ("application/vnd.apple.mpegurl", "public, max-age=60"),
    ".mpd": ("application/dash+xml", "public, max-age=60"),
    ".mp4": ("video/mp4", "public, max-age=31536000, immutable"),
    ".m4s": ("video/iso.segment", "public, max-age=31536000, immutable"),
    ".jpg": ("image/jpeg", "public, max-age=31536000, immutable"),
    ".jpeg": ("image/jpeg", "public, max-age=31536000, immutable"),
    ".png": ("image/png", "public, max-age=31536000, immutable"),
    ".vtt": ("text/vtt", "public, max-age=31536000, immutable"),
    ".json": ("application/json", "public, max-age=31536000, immutable"),
    ".key": ("application/octet-stream", "private, no-store, max-age=0"),
}

DEFAULT_CONTENT_TYPE = ("application/octet-stream", "public, max-age=3600")

# Playlists are published last so a player that fetches the master manifest the
# instant it appears finds every segment it names already present.
PLAYLIST_SUFFIXES = (".m3u8", ".mpd")


def content_type_for(relative_path: str | Path) -> Tuple[str, str]:
    """(Content-Type, Cache-Control) for one artifact path."""
    return CONTENT_TYPES.get(Path(str(relative_path)).suffix.lower(), DEFAULT_CONTENT_TYPE)


def is_playlist(relative_path: str | Path) -> bool:
    return Path(str(relative_path)).suffix.lower() in PLAYLIST_SUFFIXES


def order_for_publication(relative_paths: List[str]) -> List[str]:
    """
    Publication order: segments and supporting files first, playlists last.

    Ties are broken by the original ordering so the result is deterministic and
    a resumed upload walks the same sequence it did before.
    """
    indexed = list(enumerate(relative_paths))
    indexed.sort(key=lambda pair: (is_playlist(pair[1]), pair[0]))
    return [path for _, path in indexed]


@dataclass
class TransferError:
    """A single artifact that did not transfer, with why."""
    path: str
    message: str


@dataclass
class TransferStats:
    """Outcome of one transfer pass over a set of artifacts."""
    total: int = 0
    uploaded: int = 0
    skipped: int = 0
    failed: List[TransferError] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return self.uploaded + self.skipped == self.total and not self.failed

    def failed_paths(self) -> List[str]:
        return [entry.path for entry in self.failed]


class ArtifactTransfer(Protocol):
    """Where packaged artifacts go. Implemented by the S3 and signed backends."""

    def upload_artifacts(
        self,
        output_dir: Path,
        relative_paths: List[str],
        *,
        already_uploaded: frozenset[str] = frozenset(),
    ) -> TransferStats:
        """
        Transfer ``relative_paths`` (relative to ``output_dir``).

        ``already_uploaded`` names artifacts the caller has verified as present
        remotely; implementations must skip them so a retry after a partial
        upload re-sends only what is missing rather than re-encoding or
        re-uploading everything.
        """
        ...


class NullTransfer:
    """Transfer that refuses to run — the default when none is configured."""

    def upload_artifacts(self, output_dir: Path, relative_paths: List[str], **_: object) -> TransferStats:
        raise RuntimeError(
            "No artifact transfer configured: pass a Transfer implementation "
            "(S3Transfer for Modal, SignedHttpTransfer for a self-hosted agent)"
        )
