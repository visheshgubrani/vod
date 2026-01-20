"""
Video transcoding with GPU acceleration (NVENC).
"""
from pathlib import Path

from config import SEGMENT_DURATION, EncodingProfile
from utils.cmd import run_cmd
from video.analysis import VideoMetadata


def transcode_rendition(
    input_path: Path,
    output_path: Path,
    profile: EncodingProfile,
    metadata: VideoMetadata,
) -> Path:
    """
    Transcode single video rendition with GPU acceleration.
    
    Pipeline: CPU decode → GPU scale → NVENC encode
    
    Args:
        input_path: Path to input video
        output_path: Path for output fMP4
        profile: Encoding profile (resolution, bitrate)
        metadata: Video metadata
        
    Returns:
        Path to output file
        
    Raises:
        RuntimeError: If transcoding fails or output is invalid
    """
    # --- BUILD FILTER CHAIN ---
    filters = []
    
    # Pipeline: CPU decode → GPU scale → CPU encode
    # format=nv12 → hwupload_cuda → scale_cuda → hwdownload → format=nv12
    #
    # CRITICAL: HDR content is 10-bit - we MUST use p010le to preserve color data.
    # Using nv12 (8-bit) would destroy HDR info before tone mapping = grey/flat colors.
    
    if metadata.is_hdr:
        print(f"[HDR] Tone mapping {profile.label} (HDR → SDR)")
        # HDR: Convert to p010le (10-bit) to preserve HDR color data
        filters.append("format=p010le")
        filters.append("hwupload_cuda")
        # Scale in 10-bit to preserve quality
        filters.append(f"scale_cuda=-2:{profile.height}")
        # Tone map (10-bit -> 8-bit SDR) and output nv12
        filters.append("tonemap_cuda=tonemap=hable:desat=0:format=nv12")
        # Download from GPU to CPU for NVENC
        filters.append("hwdownload")
        filters.append("format=nv12")
    else:
        # SDR: Convert to nv12 (8-bit is fine for SDR)
        filters.append("format=nv12")
        filters.append("hwupload_cuda")
        # Scale on GPU
        filters.append(f"scale_cuda=-2:{profile.height}")
        # Download from GPU to CPU for NVENC
        filters.append("hwdownload")
        filters.append("format=nv12")
    
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        
        # Initialize CUDA device for GPU filtering
        "-init_hw_device", "cuda=cuda:0",
        "-filter_hw_device", "cuda",
        
        # CPU decoding (universal, works with VP9/AV1/etc)
        # GPU encoding via NVENC still provides the main speedup
        "-i", str(input_path),
        
        # Video filters
        "-vf", ",".join(filters),
        
        # NVENC encoding
        "-c:v", "h264_nvenc",
        "-preset:v", "p4", 
        "-tune:v", "hq",
        "-rc:v", "vbr",
        
        # Compatibility settings
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-level:v", "4.2",
        
        # Rate control
        "-b:v", profile.bitrate,
        "-maxrate:v", profile.maxrate,
        "-bufsize:v", profile.bufsize,
        
        # GOP structure
        "-g", str(int(SEGMENT_DURATION * metadata.fps)),
        "-keyint_min", str(int(SEGMENT_DURATION * metadata.fps)),
        "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_DURATION})",
        "-sc_threshold", "0",
        
        # B-frames
        "-bf", "3",
        "-b_ref_mode", "middle",
        
        # No audio in video renditions
        "-an",
        
        # Fragmented MP4 output
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        
        str(output_path)
    ]
    
    run_cmd(cmd, label=f"encode-{profile.label}")
    
    # Validate output
    if not output_path.exists():
        raise RuntimeError(f"Output file not created: {output_path}")
    
    file_size = output_path.stat().st_size
    if file_size < 1000:
        raise RuntimeError(f"Output file too small ({file_size} bytes): {output_path}")
    
    print(f"✅ {profile.label}: {file_size / 1024 / 1024:.1f} MB")
    return output_path


def transcode_audio(input_path: Path, output_path: Path) -> Path:
    """
    Extract and normalize audio track.
    
    Args:
        input_path: Path to input video
        output_path: Path for output audio fMP4
        
    Returns:
        Path to output file
        
    Raises:
        RuntimeError: If transcoding fails or output is invalid
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-i", str(input_path),
        
        # No video
        "-vn",
        
        # Loudness normalization (EBU R128 standard)
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        
        # AAC encoding
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-ar", "48000",
        
        # Fragmented MP4
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        
        str(output_path)
    ]
    
    run_cmd(cmd, label="encode-audio")
    
    # Validate output
    if not output_path.exists() or output_path.stat().st_size < 1000:
        raise RuntimeError(f"Audio output invalid: {output_path}")
    
    print(f"✅ Audio: {output_path.stat().st_size / 1024 / 1024:.1f} MB")
    return output_path
