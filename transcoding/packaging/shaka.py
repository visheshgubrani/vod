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
        "--segment_duration", str(SEGMENT_DURATION),
        
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

