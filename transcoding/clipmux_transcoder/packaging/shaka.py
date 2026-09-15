"""
Shaka Packager integration for HLS/DASH output.
"""
from pathlib import Path
from typing import Dict, List, Sequence

from clipmux_transcoder.config import SEGMENT_DURATION
from clipmux_transcoder.utils.cmd import run_cmd


def choose_segment_duration(duration: float) -> float:
    """
    Segment duration for the packager, safe for short clips.

    - >= 8s content: standard 4s segments
    - 1s .. 8s: half the duration (>= 1s)
    - < 1s clips: half the duration, floored at 0.05s
    (Shaka fails when the segment duration exceeds the media duration.)
    """
    if duration is None or duration <= 0:
        return SEGMENT_DURATION
    if duration >= 8.0:
        return float(SEGMENT_DURATION)
    if duration >= 1.0:
        return max(1.0, duration * 0.5)
    return max(0.05, duration * 0.5)


def package_with_shaka(
    renditions: Dict[str, Path],
    output_dir: Path,
    segment_duration: float = SEGMENT_DURATION,
) -> None:
    """
    Package fMP4 files into HLS and DASH manifests using Shaka Packager.
    
    For signed videos, security is enforced at the playlist level via JWT tokens
    in the delivery worker (Mux-style access control). We don't use content 
    encryption because SAMPLE-AES/CBCS isn't supported by hls.js.
    
    Args:
        renditions: Dict mapping label -> fMP4 path (e.g., {"1080p": Path(...), "audio": Path(...)})
        output_dir: Directory for packaged output
    """
    print("📦 Packaging with Shaka Packager...")
    
    # Build input specifications with per-stream segment templates.
    # Each stream gets its own init segment + individual segment files,
    # avoiding the fragile single-file byte-range mode.
    inputs = []
    
    # Video streams
    for label, fmp4_path in sorted(renditions.items()):
        if label == "audio":
            continue
        stream_dir = output_dir / f"video_{label}"
        stream_dir.mkdir(exist_ok=True)
        inputs.append(
            f"in={fmp4_path},stream=video,"
            f"init_segment={stream_dir}/init.mp4,"
            f"segment_template={stream_dir}/$Number$.m4s"
        )
    
    # Audio stream (if present)
    audio_inputs = []
    if "audio" in renditions:
        audio_dir = output_dir / "audio"
        audio_dir.mkdir(exist_ok=True)
        audio_inputs.append(
            f"in={renditions['audio']},stream=audio,"
            f"init_segment={audio_dir}/init.mp4,"
            f"segment_template={audio_dir}/$Number$.m4s"
        )
    
    # Build Shaka command
    cmd = [
        "packager",
        *inputs,
        *audio_inputs,
        
        # Segment settings
        "--segment_duration", f"{segment_duration:.3f}",
        
        # HLS output
        "--hls_master_playlist_output", str(output_dir / "playlist.m3u8"),
        "--hls_playlist_type", "VOD",
        
        # DASH output
        "--mpd_output", str(output_dir / "manifest.mpd"),
        "--generate_static_live_mpd",
    ]
    
    # NOTE: We don't use content encryption here.
    # Shaka Packager with fMP4 only supports SAMPLE-AES (cbcs/cenc), which
    # requires EME/DRM in hls.js. Traditional AES-128 only works with TS segments.
    # Instead, security is enforced at the delivery worker level:
    # - ALL resources (playlists, segments, keys) require a valid JWT token
    # - Playlist rewriting injects the token into all sub-resource URLs
    # This is the same model Mux/Cloudflare Stream use for signed playback.
    
    run_cmd(cmd, label="shaka-package")
    print("✅ Packaging complete")


def validate_package(
    output_dir: Path,
    *,
    expected_labels: Sequence[str] = (),
    expect_audio: bool = False,
) -> List[str]:
    """
    Structural check of a packaged directory, returning human-readable problems.

    The pipeline's own validation raises on the failures that make a package
    unusable; this is the *diagnostic* half, used by `doctor` and by the
    post-upload verifier to explain what is wrong rather than only that
    something is. Every check here has a player-visible failure behind it:

    - a missing master playlist is a video that will not start;
    - a missing rendition directory is a rung advertised but not delivered;
    - a missing ``init.mp4`` fails at *rendition switch* time, minutes into
      playback, which is the hardest kind of bug to attribute.
    """
    problems: List[str] = []
    output_dir = Path(output_dir)

    master = output_dir / "playlist.m3u8"
    if not master.exists():
        problems.append("playlist.m3u8 is missing")
    elif master.stat().st_size == 0:
        problems.append("playlist.m3u8 is empty")

    for label in expected_labels:
        stream_dir = output_dir / f"video_{label}"
        if not stream_dir.is_dir():
            problems.append(f"video_{label}/ is missing")
            continue
        if not (stream_dir / "init.mp4").exists():
            problems.append(f"video_{label}/init.mp4 is missing")
        if not any(stream_dir.glob("*.m4s")):
            problems.append(f"video_{label}/ has no media segments")

    if expect_audio:
        audio_dir = output_dir / "audio"
        if not audio_dir.is_dir():
            problems.append("audio/ is missing")
        elif not (audio_dir / "init.mp4").exists():
            problems.append("audio/init.mp4 is missing")

    return problems

