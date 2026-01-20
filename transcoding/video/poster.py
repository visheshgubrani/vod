"""
Poster/thumbnail generation.
"""
from utils.cmd import run_cmd


def generate_poster(input_path: str, output_path: str, duration: float) -> None:
    """
    Generate high-quality poster image at 10% timestamp.
    
    Args:
        input_path: Path to input video
        output_path: Path for output JPEG
        duration: Video duration in seconds
    """
    ts = max(1.0, min(10.0, duration * 0.10)) if duration > 0 else 1.0
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-ss", f"{ts:.3f}",
        "-i", input_path,
        "-frames:v", "1",
        "-vf", "scale=1920:-2",  # Full HD poster
        "-q:v", "2",  # High quality JPEG
        output_path
    ]
    run_cmd(cmd, label="poster")
