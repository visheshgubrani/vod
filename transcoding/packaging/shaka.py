"""
Shaka Packager integration for HLS/DASH output.
"""
from pathlib import Path
from typing import Dict

from config import SEGMENT_DURATION
from utils.cmd import run_cmd


def package_with_shaka(
    renditions: Dict[str, Path],
    output_dir: Path,
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
    
    # Build input specifications
    inputs = []
    
    # Video streams
    for label, fmp4_path in sorted(renditions.items()):
        if label == "audio":
            continue
        inputs.append(
            f"in={fmp4_path},stream=video,output={output_dir}/video_{label}.mp4"
        )
    
    # Audio stream (if present)
    audio_inputs = []
    if "audio" in renditions:
        audio_inputs.append(
            f"in={renditions['audio']},stream=audio,output={output_dir}/audio.mp4"
        )
    
    # Build Shaka command
    cmd = [
        "packager",
        *inputs,
        *audio_inputs,
        
        # Segment settings
        "--segment_duration", str(SEGMENT_DURATION),
        
        # HLS output
        "--hls_master_playlist_output", str(output_dir / "playlist.m3u8"),
        "--hls_playlist_type", "VOD",
        
        # DASH output
        "--mpd_output", str(output_dir / "manifest.mpd"),
        "--generate_static_live_mpd",
    ]
    
    # NOTE: We don't use content encryption here.
    # For "signed" videos, security is enforced at the delivery worker level:
    # - Playlists (.m3u8) require a valid JWT token
    # - Without the playlist, players can't know what segments to fetch
    # - Segment URLs aren't guessable (contain video ID)
    # This is the same model Mux uses for "signed" playback policy.
    
    run_cmd(cmd, label="shaka-package")
    print("✅ Packaging complete")

