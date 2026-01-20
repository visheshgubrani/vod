"""
Shaka Packager integration for HLS/DASH output.
"""
import hashlib
from pathlib import Path
from typing import Dict, Optional

from config import SEGMENT_DURATION
from utils.cmd import run_cmd


def package_with_shaka(
    renditions: Dict[str, Path],
    output_dir: Path,
    encryption_key: Optional[bytes] = None
) -> None:
    """
    Package fMP4 files into HLS and DASH manifests using Shaka Packager.
    
    Args:
        renditions: Dict mapping label -> fMP4 path (e.g., {"1080p": Path(...), "audio": Path(...)})
        output_dir: Directory for packaged output
        encryption_key: Optional 16-byte key for AES-128 encryption
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
    
    # Optional encryption
    if encryption_key:
        key_id = hashlib.md5(encryption_key).hexdigest()
        key_file = output_dir / "enc.key"
        key_file.write_bytes(encryption_key)
        
        cmd.extend([
            "--enable_raw_key_encryption",
            "--keys", f"label=:key_id={key_id}:key={encryption_key.hex()}",
            "--protection_scheme", "cbcs",
        ])
        print("🔐 AES-128 encryption enabled")
    
    run_cmd(cmd, label="shaka-package")
    print("✅ Packaging complete")
