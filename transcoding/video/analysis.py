"""
Video metadata extraction and analysis.
"""
import json
from dataclasses import dataclass
from typing import List

from config import ENCODING_PROFILES, EncodingProfile
from utils.cmd import run_cmd


@dataclass
class VideoMetadata:
    """Metadata extracted from video file."""
    width: int
    height: int
    duration: float
    fps: float
    has_audio: bool
    is_hdr: bool
    
    @property
    def is_vertical(self) -> bool:
        """True if video is portrait orientation (9:16)."""
        return self.height > self.width
    
    @property
    def aspect_ratio(self) -> str:
        """Aspect ratio as string (e.g., '1.78:1')."""
        ratio = self.width / self.height if self.height > 0 else 16/9
        return f"{ratio:.2f}:1"


def get_video_metadata(filepath: str) -> VideoMetadata:
    """
    Extract video metadata using ffprobe.
    
    Args:
        filepath: Path to video file
        
    Returns:
        VideoMetadata with resolution, duration, fps, audio, HDR info
    """
    # Get video stream info
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,color_transfer:format=duration",
        "-of", "json",
        filepath
    ]
    p = run_cmd(cmd, label="ffprobe-video")
    data = json.loads(p.stdout)
    
    video = data.get("streams", [{}])[0]
    fmt = data.get("format", {})
    
    # Parse FPS
    fps_str = video.get("r_frame_rate", "30/1")
    num, denom = map(int, fps_str.split("/"))
    fps = num / denom if denom > 0 else 30.0
    
    # Detect HDR
    color_transfer = video.get("color_transfer", "")
    is_hdr = color_transfer in ["smpte2084", "arib-std-b67"]
    
    # Check for audio streams
    cmd_audio = [
        "ffprobe", "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_type",
        "-of", "json",
        filepath
    ]
    p_audio = run_cmd(cmd_audio, label="ffprobe-audio", check=False)
    has_audio = len(json.loads(p_audio.stdout).get("streams", [])) > 0
    
    return VideoMetadata(
        width=int(video.get("width", 1920)),
        height=int(video.get("height", 1080)),
        duration=float(fmt.get("duration", 0)),
        fps=fps,
        has_audio=has_audio,
        is_hdr=is_hdr,
    )


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
