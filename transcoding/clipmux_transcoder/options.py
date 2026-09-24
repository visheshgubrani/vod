"""
Immutable processing options — the input half of a job's identity.

Every field here is part of what gets bound to a job at creation time. The plan
requires that "provider selection is stored when the job is created; changing the
installation default does not reroute existing jobs", and the same reasoning
applies to the whole option set: a job that is retried in three days must encode
with the settings the owner chose, not with whatever the agent's environment
happens to say then.

``plan_fingerprint`` is what makes reuse safe: it is the value stored alongside
encoded work, so a cached rendition is only reused when the options that produced
it are unchanged.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Optional, Sequence

from clipmux_transcoder.config import DEFAULT_MAX_HEIGHT, PROCESSING_PLAN_VERSION
from clipmux_transcoder.planning import POLICY_CAPPED

# Provider identifiers — the stored value, never re-resolved at run time.
PROVIDER_MODAL = "modal"
PROVIDER_LOCAL = "local"
PROVIDERS = (PROVIDER_MODAL, PROVIDER_LOCAL)

PLAYBACK_PUBLIC = "public"
PLAYBACK_SIGNED = "signed"

# Wire name → engine field. The API stores camelCase (it is a TypeScript
# codebase); the engine uses snake_case. One table, so the mapping is visible and
# testable rather than repeated at each parse site.
WIRE_ALIASES: Dict[str, str] = {
    "playbackPolicy": "playback_policy",
    "organizationId": "organization_id",
    "videoId": "video_id",
    "attemptId": "attempt_id",
    "generateSubtitle": "generate_subtitle",
    "generateChapters": "generate_chapters",
    "whisperModel": "whisper_model",
    "transcribeLanguage": "transcribe_language",
    "renditionPolicy": "rendition_policy",
    "maxHeight": "max_height",
    "includeHeights": "include_heights",
    "encoderBackend": "encoder_backend",
    "encoderDevice": "encoder_device",
    "renditionConcurrency": "rendition_concurrency",
    "audioConcurrency": "audio_concurrency",
    "uploadConcurrency": "upload_concurrency",
    "ffmpegThreads": "ffmpeg_threads",
    "cpuRenditionConcurrency": "cpu_rendition_concurrency",
    "cpuFfmpegThreads": "cpu_ffmpeg_threads",
    "hybridFfmpegThreads": "hybrid_ffmpeg_threads",
    "audioFfmpegThreads": "audio_ffmpeg_threads",
    "stallTimeoutSeconds": "stall_timeout_seconds",
    "scratchQuotaBytes": "scratch_quota_bytes",
    "segmentDuration": "segment_duration",
    "extractAudioOnly": "extract_audio_only",
}


@dataclass(frozen=True)
class ProcessingOptions:
    """Everything the pipeline needs that is not the source or the machine."""
    playback_policy: str = PLAYBACK_PUBLIC
    organization_id: Optional[str] = None
    video_id: str = ""
    attempt_id: str = ""

    generate_subtitle: bool = False
    generate_chapters: bool = False
    whisper_model: str = "large-v3-turbo"
    transcribe_language: Optional[str] = None

    rendition_policy: str = POLICY_CAPPED
    max_height: int = DEFAULT_MAX_HEIGHT
    include_heights: Sequence[int] = field(default_factory=tuple)

    encoder_backend: str = "auto"
    encoder_device: Optional[str] = None

    # One active job and one video rendition encode per agent by default; the
    # operator raises these explicitly. The old L4-specific heuristics are gone
    # from shared logic because they were sized for one specific Modal GPU.
    rendition_concurrency: int = 1
    audio_concurrency: int = 1
    upload_concurrency: int = 4
    ffmpeg_threads: int = 0  # 0 = let FFmpeg decide from its own CPU budget

    # Per-path bounds. Each execution path has different CPU needs — a full-GPU
    # encode needs almost none, a hybrid encode decodes and scales in software,
    # and a CPU encode is all software — so bounding them with one number starves
    # the GPU paths that still depend on the CPU. 0 means "no separate bound".
    cpu_rendition_concurrency: int = 0
    cpu_ffmpeg_threads: int = 0
    hybrid_ffmpeg_threads: int = 0
    audio_ffmpeg_threads: int = 0

    stall_timeout_seconds: float = 900.0
    scratch_quota_bytes: Optional[int] = None

    require_renditions: bool = True
    segment_duration: Optional[float] = None
    extract_audio_only: bool = False

    def resolved_heights(self) -> tuple[int, ...]:
        return tuple(int(height) for height in self.include_heights)

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["include_heights"] = list(self.include_heights)
        return payload

    def plan_fingerprint(self, *, toolchain: str = "") -> str:
        """
        Stable hash of everything that changes the produced bytes.

        Deliberately excludes `attempt_id`, `video_id` and the upload/transfer
        settings: those change per attempt but do not change the encode, and
        including them would defeat reuse across a retry — the case reuse exists
        for. `playback_policy` and `organization_id` *are* included because they
        are written into object metadata at upload time.

        ``toolchain`` is the identity of the FFmpeg/Shaka build that would do the
        work (see ``encoding.probe.toolchain_versions``). Two machines with
        different FFmpeg versions do not produce byte-identical renditions, so a
        cached rendition from the old toolchain must not be reused after an
        image upgrade — which is exactly what including it prevents. Thread
        bounds are in the material for the same reason: x264's output depends on
        how many threads it was given.
        """
        material = {
            "planVersion": PROCESSING_PLAN_VERSION,
            "playbackPolicy": self.playback_policy,
            "organizationId": self.organization_id,
            "subtitle": self.generate_subtitle,
            "chapters": self.generate_chapters,
            "whisperModel": self.whisper_model if self.generate_subtitle else None,
            "language": self.transcribe_language if self.generate_subtitle else None,
            "renditionPolicy": self.rendition_policy,
            "maxHeight": self.max_height,
            "includeHeights": sorted(self.resolved_heights()),
            "encoderBackend": self.encoder_backend,
            "segmentDuration": self.segment_duration,
            "audioOnly": self.extract_audio_only,
            "cpuThreads": self.cpu_ffmpeg_threads,
            "ffmpegThreads": self.ffmpeg_threads,
            "hybridThreads": self.hybrid_ffmpeg_threads,
            "audioThreads": self.audio_ffmpeg_threads,
            "toolchain": toolchain or None,
        }
        blob = json.dumps(material, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    @classmethod
    def from_dict(cls, payload: Dict[str, Any] | None) -> "ProcessingOptions":
        """
        Build from a stored job's option blob.

        Accepts **both** the API's camelCase wire names and the engine's
        snake_case field names. Without the aliases, a job queued with
        `generateSubtitle: true` silently ran with subtitles off: the key did not
        match any field, unknown keys are dropped by design, and nothing reported
        the loss. A setting that vanishes without a trace is worse than one that
        is rejected.

        Unknown keys are still dropped rather than raising: a job created by a
        newer API must run on an older agent where the extra options do not
        apply, instead of failing outright.
        """
        if not payload:
            return cls()

        known = {field_name for field_name in cls.__dataclass_fields__}
        filtered: Dict[str, Any] = {}
        for key, value in payload.items():
            if key in known:
                filtered[key] = value
                continue
            alias = WIRE_ALIASES.get(key)
            if alias is not None and alias not in filtered:
                filtered[alias] = value

        if filtered.get("include_heights") is not None:
            filtered["include_heights"] = tuple(int(h) for h in filtered["include_heights"])
        return cls(**filtered)

    def with_agent_limits(self, config: Any) -> "ProcessingOptions":
        """
        Apply the machine operator's constraints to a job's options.

        Two different authorities meet here, and conflating them is why an
        explicit CPU/GPU selection had no effect on execution:

        - The **job** decides what the owner asked for (ladder, policy,
          subtitles). That is frozen at creation and must not change.
        - The **machine** decides what this computer will spend (which encoder,
          how many renditions at once, how long a stall is tolerated, where the
          Whisper weights come from). Those are the operator's, not the job's.

        So machine settings always bound resources, and they override the
        encoder only when the job did not name one — a job that explicitly asked
        for NVENC on a machine configured for `cpu` is a mismatch the encoder
        selection reports, not something to silently rewrite.
        """
        from dataclasses import replace

        updates: Dict[str, Any] = {}

        if self.encoder_backend in ("", "auto") and config.encoder_backend:
            updates["encoder_backend"] = config.encoder_backend
        if not self.encoder_device and config.encoder_device:
            updates["encoder_device"] = config.encoder_device

        # Resource bounds take the smaller of the two: an operator who capped
        # this machine at one rendition did not agree to four because a job asked.
        updates["rendition_concurrency"] = max(
            1, min(self.rendition_concurrency, config.capacity_renditions)
        )
        if self.cpu_rendition_concurrency:
            # The operator's capacity is the ceiling for this path too.
            updates["cpu_rendition_concurrency"] = max(
                1, min(self.cpu_rendition_concurrency, config.capacity_renditions)
            )
        updates["upload_concurrency"] = max(
            1, min(self.upload_concurrency, config.upload_concurrency)
        )
        updates["stall_timeout_seconds"] = config.stall_timeout_seconds

        if not self.whisper_model and config.whisper_model:
            updates["whisper_model"] = config.whisper_model
        if not self.transcribe_language and config.transcribe_language:
            updates["transcribe_language"] = config.transcribe_language

        if config.scratch_quota_bytes:
            updates["scratch_quota_bytes"] = config.scratch_quota_bytes

        return replace(self, **updates)
