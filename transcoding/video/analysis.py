"""
Video metadata extraction and analysis.
"""
import json
from dataclasses import dataclass
from typing import List, Optional

from config import ENCODING_PROFILES, EncodingProfile
from errors import (
    ERROR_EMPTY_FILE,
    ERROR_INVALID_CONTAINER,
    ERROR_INVALID_METADATA,
    TranscodeError,
)
from utils.cmd import run_cmd


@dataclass
class VideoMetadata:
    """Metadata extracted from video file."""
    width: int
    height: int
    duration: float
    fps: float
    has_audio: bool
    has_video: bool
    is_hdr: bool
    codec_name: str  # e.g., "h264", "hevc", "av1", "vp9"
    rotation: float = 0.0  # degrees from ffprobe side data (0/90/180/270)

    @property
    def is_vertical(self) -> bool:
        """True if video is portrait orientation (9:16), rotation-aware."""
        return self.height > self.width

    @property
    def aspect_ratio(self) -> str:
        """Aspect ratio as string (e.g., '1.78:1')."""
        ratio = self.width / self.height if self.height > 0 else 16 / 9
        return f"{ratio:.2f}:1"


def _fps_value(stream: dict) -> float:
    """Parse r_frame_rate (e.g. '30000/1001') with sanitization."""
    raw = stream.get("r_frame_rate") or stream.get("avg_frame_rate") or ""
    fps: float = 30.0
    if isinstance(raw, (int, float)):
        fps = float(raw)
    elif "/" in raw:
        try:
            num, denom = map(int, raw.split("/"))
            fps = num / denom if denom > 0 else 30.0
        except ValueError:
            fps = 30.0
    if not fps or fps <= 0 or fps > 120:
        print(f"[ANALYSIS] Unusable fps {raw!r} — normalizing to 30.0")
        fps = 30.0
    return fps


def _rotation_of(stream: dict) -> float:
    """Rotation (degrees) from ffprobe side_data_list, 0 when absent."""
    for side in stream.get("side_data_list") or []:
        rotation = side.get("rotation")
        if isinstance(rotation, (int, float)) and rotation not in (0, 360):
            return float(rotation)
    return 0.0


def _display_dimensions(stream: dict, rotation: float) -> tuple[int, int]:
    """
    Width/height adjusted for rotation side data: a 90/270 rotation means the
    coded frame is landscape but playback is portrait — swap dimensions so
    ladder/vertical decisions match what viewers actually see.
    """
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise TranscodeError(
            ERROR_INVALID_METADATA,
            f"Video stream has unusable dimensions {width}x{height}",
        )
    if rotation % 180 != 0 and width != height:
        return (height, width)
    return (width, height)


def parse_ffprobe(data: dict) -> VideoMetadata:
    """
    Pure parser for ffprobe -show_streams -show_format JSON output.

    Raises typed TranscodeErrors:
    - EMPTY_FILE          no streams at all, or duration missing/<= 0
    - INVALID_CONTAINER   no audio AND no video streams
    - INVALID_METADATA    video stream present but dimensions unusable
    """
    streams = data.get("streams") or []
    fmt = data.get("format") or {}

    video_streams = [s for s in streams if s.get("codec_type") == "video"]
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]

    if not video_streams and not audio_streams:
        raise TranscodeError(
            ERROR_INVALID_CONTAINER,
            "No video or audio stream found — file is not a playable media container",
        )

    duration_raw = fmt.get("duration") or (video_streams or audio_streams)[0].get("duration")
    try:
        duration = float(duration_raw) if duration_raw not in (None, "") else 0.0
    except (TypeError, ValueError):
        duration = 0.0
    if not duration or duration <= 0:
        raise TranscodeError(
            ERROR_EMPTY_FILE,
            f"File has no usable duration ({duration_raw!r}) — truncated or empty media",
        )

    has_video = bool(video_streams)
    has_audio = bool(audio_streams)

    if not has_video:
        # Audio-only is a supported analysis outcome; main.py decides what to
        # do with it (typed AUDIO_ONLY_UNSUPPORTED until passthrough ships).
        return VideoMetadata(
            width=0,
            height=0,
            duration=duration,
            fps=30.0,
            has_audio=True,
            has_video=False,
            is_hdr=False,
            codec_name="",
        )

    video = video_streams[0]
    rotation = _rotation_of(video)
    width, height = _display_dimensions(video, rotation)

    color_transfer = video.get("color_transfer", "")
    is_hdr = color_transfer in ("smpte2084", "arib-std-b67")

    return VideoMetadata(
        width=width,
        height=height,
        duration=duration,
        fps=_fps_value(video),
        has_audio=has_audio,
        has_video=True,
        is_hdr=is_hdr,
        codec_name=video.get("codec_name") or "unknown",
        rotation=rotation,
    )


def get_video_metadata(filepath: str) -> VideoMetadata:
    """
    Extract video metadata using ffprobe (one call: all streams + format).
    """
    cmd = [
        "ffprobe", "-v", "error",
        "-show_streams",
        "-show_format",
        "-of", "json",
        filepath,
    ]
    p = run_cmd(cmd, label="ffprobe", check=False)
    if p.returncode != 0:
        raise TranscodeError(
            ERROR_INVALID_CONTAINER,
            f"ffprobe could not read the file (exit {p.returncode}): "
            f"{(p.stderr or '').strip()[:300]}",
        )
    return parse_ffprobe(json.loads(p.stdout or "{}"))


def select_optimal_ladder(metadata: VideoMetadata) -> List[EncodingProfile]:
    """
    Smart ABR ladder selection.

    - No upscaling (skip renditions higher than source)
    - Skip renditions too close in quality (within 15%)
    - Optimize for vertical video (limit to mobile-friendly resolutions)

    Args:
        metadata: Video metadata

    Returns:
        List of EncodingProfile to encode
    """
    candidates = [p for p in ENCODING_PROFILES if p.height <= metadata.height]

    if not candidates:
        candidates = [ENCODING_PROFILES[-1]]  # At least 360p

    # Vertical video optimization (9:16 content)
    if metadata.is_vertical:
        print("[OPTIMIZER] Vertical video detected - limiting to mobile-friendly resolutions")
        candidates = [p for p in candidates if p.height <= 1080]

    # Skip renditions within 15% height difference (quality too similar)
    selected = []
    last_height = 0
    for profile in sorted(candidates, key=lambda p: p.height, reverse=True):
        if not selected or (last_height - profile.height) / last_height > 0.15:
            selected.append(profile)
            last_height = profile.height

    print(f"[LADDER] Selected {len(selected)} renditions: {[p.label for p in selected]}")
    return selected
