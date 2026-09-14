"""
Pipeline results: the artifact inventory and the processing metadata.

The artifact inventory is the load-bearing half. Completion is *verified against
it* — the agent uploads these paths, then the API checks each one exists with
the recorded size before the video is allowed to become playable. A result that
merely said "success" would let a partial upload mark a video ready, which is
the failure mode the inventory exists to prevent.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class Artifact:
    """
    One file the job produced, described independently of where it was stored.

    ``path`` is always relative to the packaged output directory. That keeps the
    inventory free of host paths — which is what lets the API issue upload grants
    for "inventory-listed paths inside the attempt prefix" and nothing else.
    """
    path: str
    size: int
    checksum: str = ""
    content_type: str = ""
    role: str = "segment"  # segment | playlist | poster | subtitle | chapters | other

    @property
    def is_playlist(self) -> bool:
        return self.role == "playlist"


@dataclass
class RenditionReport:
    """
    What was actually encoded for one rung, and by which execution path.

    ``backend`` and ``mode`` are per rendition because a ladder can genuinely be
    split: the first rung may hit a session limit and finish on the CPU while the
    rest stay on the GPU. The job-level ``backend`` is then ``mixed``, and these
    are the entries that say which rung was which.
    """
    label: str
    width: int
    height: int
    bitrate: str
    backend: str
    mode: str = ""
    attempts: int = 0
    seconds: float = 0.0
    files: int = 0
    bytes: int = 0

    def as_payload(self) -> dict:
        return {
            "label": self.label,
            "width": self.width,
            "height": self.height,
            "bitrate": self.bitrate,
            "backend": self.backend,
            "mode": self.mode,
            "attempts": self.attempts,
            "seconds": self.seconds,
            "bytes": self.bytes,
        }


@dataclass
class EnrichmentStatus:
    """A nonfatal enrichment (poster, subtitles, chapters)."""
    name: str
    requested: bool = False
    generated: bool = False
    status: Optional[str] = None
    url: str = ""
    error: str = ""
    data: Optional[list] = None

    def as_payload(self) -> dict:
        payload = {
            "requested": self.requested,
            "generated": self.generated,
            "status": self.status,
        }
        if self.url:
            payload["url"] = self.url
        if self.data is not None:
            payload["data"] = self.data
        return payload


@dataclass
class ProcessingMetadata:
    """Timings and throughput, for metering and support."""
    source_size_bytes: int = 0
    transcoded_size_bytes: int = 0
    duration_seconds: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    has_audio: bool = False
    has_video: bool = True
    is_hdr: bool = False
    is_vertical: bool = False
    aspect_ratio: str = ""
    timings: Dict[str, float] = field(default_factory=dict)
    backend_used: str = ""
    fallback_reasons: List[str] = field(default_factory=list)
    plan_fingerprint: str = ""
    source_sha256: str = ""
    # Toolchain identity and per-rendition execution details. Additive: the API
    # stores them as diagnostics, and older payloads simply have neither.
    toolchain: Dict[str, str] = field(default_factory=dict)
    rendition_executions: List[dict] = field(default_factory=list)

    @property
    def processing_speed(self) -> float:
        elapsed = self.timings.get("transcode") or 0.0
        return round(self.duration_seconds / elapsed, 2) if elapsed > 0 else 0.0

    def as_payload(self) -> dict:
        return {
            "total_time": round(sum(self.timings.values()), 2),
            "transcode_time": round(self.timings.get("transcode", 0.0), 2),
            "package_time": round(self.timings.get("package", 0.0), 2),
            "upload_time": round(self.timings.get("upload", 0.0), 2),
            "snapshot_time": round(self.timings.get("snapshot", 0.0), 2),
            "processing_speed": self.processing_speed,
            "source_size_mb": round(self.source_size_bytes / (1024 * 1024), 2),
            "transcoded_size": self.transcoded_size_bytes,
            "transcoded_size_mb": round(self.transcoded_size_bytes / (1024 * 1024), 2),
            "backend": self.backend_used,
            "fallbacks": list(self.fallback_reasons),
            "plan_fingerprint": self.plan_fingerprint,
            "toolchain": dict(self.toolchain),
            "renditions": list(self.rendition_executions),
        }


@dataclass
class PipelineResult:
    """Everything a caller needs to publish and account for a job."""
    video_id: str
    attempt_id: str = ""
    artifacts: List[Artifact] = field(default_factory=list)
    renditions: List[RenditionReport] = field(default_factory=list)
    enrichments: Dict[str, EnrichmentStatus] = field(default_factory=dict)
    metadata: ProcessingMetadata = field(default_factory=ProcessingMetadata)
    playback_policy: str = "public"
    warnings: List[str] = field(default_factory=list)

    @property
    def total_bytes(self) -> int:
        return sum(artifact.size for artifact in self.artifacts)

    def artifact_for_role(self, role: str) -> Optional[Artifact]:
        return next((artifact for artifact in self.artifacts if artifact.role == role), None)

    def relative_paths(self) -> List[str]:
        return [artifact.path for artifact in self.artifacts]

    def inventory_payload(self, key_prefix: str = "") -> dict:
        """
        Wire form of the inventory: paths, sizes and hashes, nothing else.

        ``key_prefix`` is the storage prefix the artifacts were written to. The
        Modal runner passes its legacy `videos/<id>` layout, because its callback
        carries complete object keys and the API's rebasing is opt-in; a
        self-hosted agent passes nothing, because the API already knows the
        attempt prefix and re-bases against it.
        """
        return {
            "video_id": self.video_id,
            "attempt_id": self.attempt_id,
            "artifacts": [
                {
                    "path": prefixed_path(key_prefix, artifact.path),
                    "size": artifact.size,
                    "checksum": artifact.checksum,
                    "contentType": artifact.content_type,
                    "role": artifact.role,
                }
                for artifact in sorted(self.artifacts, key=lambda entry: entry.path)
            ],
        }

    def as_payload(self, key_prefix: str = "") -> dict:
        """
        Completion payload.

        Shaped like the Modal callback so both providers finalize through the
        same server code path: `outputs`/`metadata`/`processing`/`subtitle`/
        `chapters` are the vocabulary the API's lifecycle finalizer already
        understands.

        ``key_prefix`` must be the prefix the outputs were **actually uploaded
        to**. The Modal runner uploads to `videos/<video-id>/` and its callback is
        handled with rebasing *off*, so it passes that prefix here; omitting it
        would send `playlist.m3u8` and the API would save
        `<delivery>/playlist.m3u8`, a URL that 404s for every viewer. A
        self-hosted agent omits it because the API re-bases against the attempt
        prefix it recorded in the inventory.
        """
        playlist = self.artifact_for_role("playlist")
        poster = self.artifact_for_role("poster")
        dash = self.artifact_for_role("dash")
        subtitle = self.enrichments.get("subtitles")
        chapters = self.enrichments.get("chapters")

        return {
            "status": "success",
            "video_id": self.video_id,
            "attempt_id": self.attempt_id,
            "metadata": {
                "width": self.metadata.width,
                "height": self.metadata.height,
                "duration": self.metadata.duration_seconds,
                "fps": self.metadata.fps,
                "has_audio": self.metadata.has_audio,
                "has_video": self.metadata.has_video,
                "is_hdr": self.metadata.is_hdr,
                "is_vertical": self.metadata.is_vertical,
                "aspect_ratio": self.metadata.aspect_ratio,
            },
            "outputs": {
                "renditions": [rendition.label for rendition in self.renditions],
                "hls_playlist": prefixed_path(key_prefix, playlist.path) if playlist else None,
                "dash_manifest": prefixed_path(key_prefix, dash.path) if dash else None,
                "poster": prefixed_path(key_prefix, poster.path) if poster else None,
                "subtitles": (
                    prefixed_path(key_prefix, subtitle.url)
                    if subtitle and subtitle.generated and subtitle.url
                    else None
                ),
            },
            "subtitle": (subtitle.as_payload() if subtitle else {"requested": False}),
            "chapters": (chapters.as_payload() if chapters else {"requested": False}),
            "processing": self.metadata.as_payload(),
            "playback_policy": self.playback_policy,
            "inventory": self.inventory_payload(key_prefix)["artifacts"],
            "warnings": list(self.warnings),
        }

def prefixed_path(key_prefix: str, path: str) -> str:
    """Join a storage key prefix onto an output-relative artifact path."""
    if not key_prefix:
        return path
    return f"{key_prefix.strip('/')}/{str(path).lstrip('/')}"


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Streaming SHA-256. Used for source identity and artifact checksums."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_inventory(output_dir: Path, *, hashes: bool = True) -> List[Artifact]:
    """
    Describe every file under ``output_dir``.

    Roles are assigned from the path so the caller can find the playlists and the
    poster without guessing names. Hashes are computed here rather than taken
    from multipart ETags: an ETag is not a content hash for multipart uploads,
    and comparing them across two different upload paths is how a corrupted
    segment gets accepted.
    """
    artifacts: List[Artifact] = []
    for file_path in sorted(output_dir.rglob("*")):
        if not file_path.is_file():
            continue
        relative = file_path.relative_to(output_dir).as_posix()
        artifacts.append(
            Artifact(
                path=relative,
                size=file_path.stat().st_size,
                checksum=sha256_file(file_path) if hashes else "",
                role=classify_artifact(relative),
            )
        )
    return artifacts


def classify_artifact(relative_path: str) -> str:
    """Role of one artifact, from its path. Pure, checked with literals."""
    name = relative_path.rsplit("/", 1)[-1].lower()
    suffix = name.rsplit(".", 1)[-1] if "." in name else ""
    if name == "playlist.m3u8":
        return "playlist"
    if name == "manifest.mpd":
        return "dash"
    if suffix == "m3u8":
        return "playlist"
    if suffix == "mpd":
        return "dash"
    if name in ("poster.jpg", "poster.jpeg", "poster.png", "thumbnail.jpg"):
        return "poster"
    if suffix == "vtt":
        return "subtitle"
    if name == "chapters.json":
        return "chapters"
    if suffix in ("m4s", "mp4", "ts", "aac", "cmfv", "cmfa"):
        return "segment"
    return "other"


def inventory_json(artifacts: List[Artifact]) -> str:
    return json.dumps(
        [
            {"path": artifact.path, "size": artifact.size, "checksum": artifact.checksum}
            for artifact in sorted(artifacts, key=lambda entry: entry.path)
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
