"""
Rendition planning: source metadata + options → the exact renditions to encode.

Two policies, and the difference is deliberate rather than transitional:

- ``legacy`` reproduces the original Modal ladder byte-for-byte, including its
  habit of falling back to a 360p rung for a source smaller than 360p. Existing
  installations keep their outputs unchanged, which is what makes the engine
  extraction reviewable.
- ``capped`` is the v1 self-hosted default: a 1080p-capped adaptive ladder that
  never upscales. A source below the smallest rung gets a **source-sized**
  rendition with even dimensions instead of an upscaled 360p one — upscaling a
  240p recording to 360p costs bytes and adds no detail, and the dashboard then
  reports a resolution the source never had.

The dimensions are resolved here, not left to a ``scale=-2:h`` expression, so
the plan is checkable without running FFmpeg and so the dashboard can show the
dimensions that were actually encoded.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

from clipmux_transcoder.config import (
    DEFAULT_MAX_HEIGHT,
    ENCODING_PROFILES,
    LADDER_MIN_HEIGHT_GAP,
    EncodingProfile,
)
from clipmux_transcoder.encoding.backends import RenderSpec, even, fit_dimensions
from clipmux_transcoder.video.analysis import VideoMetadata, select_optimal_ladder

POLICY_LEGACY = "legacy"
POLICY_CAPPED = "capped"

POLICIES = (POLICY_LEGACY, POLICY_CAPPED)



def source_sized_profile(metadata: VideoMetadata) -> Optional[EncodingProfile]:
    """
    A single rendition matching the source's own size, for sub-rung sources.

    Bitrate is scaled from the 360p rung by pixel count and floored at a level
    that still looks acceptable for the tiny dimensions involved, so a 240p
    source is not handed an 800 kbps budget it cannot use.
    """
    if metadata.width <= 0 or metadata.height <= 0:
        return None
    height = even(metadata.height)
    # 360p rung is 800k at 640x360. Scale by area, clamped to [300k, 800k].
    area_ratio = (even(metadata.width) * height) / (640 * 360)
    kbps = int(min(800, max(300, round(800 * area_ratio))))
    return EncodingProfile(
        label=f"source-{height}p",
        height=height,
        bitrate=f"{kbps}k",
        maxrate=f"{int(kbps * 1.25)}k",
        bufsize=f"{int(kbps * 2)}k",
    )


def _capped_candidates(metadata: VideoMetadata, max_height: int) -> List[EncodingProfile]:
    limit = min(max_height, metadata.height) if metadata.height > 0 else max_height
    candidates = [profile for profile in ENCODING_PROFILES if profile.height <= limit]

    if metadata.is_vertical:
        # Portrait content is watched on phones; a 1080p *height* rung on a 9:16
        # frame is a 608x1080 rendition, which is the top of what mobile needs.
        candidates = [profile for profile in candidates if profile.height <= DEFAULT_MAX_HEIGHT]

    selected: List[EncodingProfile] = []
    last_height = 0
    for profile in sorted(candidates, key=lambda entry: entry.height, reverse=True):
        if not selected or (last_height - profile.height) / last_height > LADDER_MIN_HEIGHT_GAP:
            selected.append(profile)
            last_height = profile.height
    return selected


def plan_renditions(
    metadata: VideoMetadata,
    *,
    policy: str = POLICY_CAPPED,
    max_height: int = DEFAULT_MAX_HEIGHT,
    include_heights: Sequence[int] | None = None,
    fps: Optional[float] = None,
) -> List[RenderSpec]:
    """
    Resolve the renditions to encode.

    ``include_heights`` (1440/2160, say) is an *explicit* widening of the cap,
    which is how the dashboard exposes those rungs without making them the
    default on a machine that cannot afford them.
    """
    if not metadata.has_video:
        return []

    frame_rate = float(fps if fps is not None else (metadata.fps or 30.0))

    if policy == POLICY_LEGACY and not include_heights:
        profiles = select_optimal_ladder(metadata)
        return [
            RenderSpec.from_profile(
                profile,
                *fit_dimensions(metadata.width, metadata.height, profile.height),
                fps=frame_rate,
            )
            for profile in profiles
        ]

    if policy not in POLICIES:
        raise ValueError(f"unknown rendition policy: {policy!r}")

    effective_cap = max_height
    if include_heights:
        effective_cap = max([max_height, *[int(height) for height in include_heights]])

    profiles = _capped_candidates(metadata, effective_cap)

    if not profiles:
        # Source below the smallest rung: encode it at its own size rather than
        # upscaling. Preserves detail, saves bytes, and reports the truth.
        sized = source_sized_profile(metadata)
        profiles = [sized] if sized else []

    # `metadata.width`/`height` are the *displayed* dimensions (the analyser has
    # already applied any rotation side data), which is exactly what the filter
    # graph will see — FFmpeg rotates automatically when decoding.
    return [
        RenderSpec.from_profile(
            profile,
            *fit_dimensions(metadata.width, metadata.height, profile.height),
            fps=frame_rate,
        )
        for profile in profiles
    ]


@dataclass
class AudioPlan:
    """Which audio track to encode, and the index needed to pin it."""
    stream_index: int
    channels: int
    codec: str
    language: str = ""

    @property
    def is_stereo(self) -> bool:
        return self.channels >= 2


def plan_audio(streams: Sequence[dict]) -> Optional[AudioPlan]:
    """
    Choose the audio track to carry into the package.

    "Default" is FFmpeg's own disposition flag when present, and the first usable
    track otherwise — the documented fallback. Tracks with no codec or no
    channels are skipped rather than encoded into an unplayable stream.
    """
    usable = []
    for stream in streams:
        if stream.get("codec_type") != "audio":
            continue
        codec = (stream.get("codec_name") or "").strip()
        if not codec:
            continue
        usable.append(stream)

    if not usable:
        return None

    chosen = next(
        (stream for stream in usable if (stream.get("disposition") or {}).get("default")),
        usable[0],
    )
    try:
        channels = int(chosen.get("channels") or 0)
    except (TypeError, ValueError):
        channels = 0
    tags = chosen.get("tags") or {}
    return AudioPlan(
        stream_index=int(chosen.get("index") or 0),
        channels=channels,
        codec=(chosen.get("codec_name") or "").strip(),
        language=str(tags.get("language") or ""),
    )
