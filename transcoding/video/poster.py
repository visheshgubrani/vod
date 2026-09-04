"""
Poster/thumbnail generation.
"""
from utils.cmd import run_cmd


def choose_poster_time(duration: float) -> float:
    """
    Seek time for the poster frame, guaranteed to be inside the clip.

    - duration <= 0           -> 0.1s
    - duration >= 10s         -> 10% of duration, clamped to [1.0, 10.0]
    - very short clips (<10s) -> 25% in, so the frame is not the very first
    Never exceeds 95% of the duration (and never below 0.05s for tiny files).
    """
    if duration <= 0:
        return 0.1
    if duration >= 10:
        candidate = min(10.0, max(1.0, duration * 0.10))
    else:
        candidate = max(0.1, min(duration * 0.25, duration * 0.90))
    return min(candidate, max(0.05, duration * 0.95))


def generate_poster(input_path: str, output_path: str, duration: float) -> None:
    """
    Generate high-quality poster image at a safe timestamp.

    Args:
        input_path: Path to input video
        output_path: Path for output JPEG
        duration: Video duration in seconds
    """
    ts = choose_poster_time(duration)
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
