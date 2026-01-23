"""
Video transcoding with GPU acceleration (NVENC).
"""
from pathlib import Path

from config import SEGMENT_DURATION, EncodingProfile
from utils.cmd import run_cmd
from video.analysis import VideoMetadata


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
    Transcode single video rendition.
    Hybrid Pipeline with safe codec detection:
    - Safe codecs (h264/hevc): NVDEC (GPU) -> CUDA Scale -> NVENC (GPU)
    - Risky codecs (av1/vp9): CPU Decode -> CUDA Upload -> CUDA Scale -> NVENC (GPU)
    """
    
    # 1. Detect Safe Codecs
    # We remove mpeg2/mpeg4 from 'safe' list unless you are sure your L4 supports them perfectly.
    # H264 and HEVC are the most important ones for speed.
    SAFE_GPU_DECODE_CODECS = ["h264", "hevc", "mjpeg", "avc", "avc1"]
    
    use_gpu_decode = metadata.codec_name.lower() in SAFE_GPU_DECODE_CODECS
    
    if use_gpu_decode:
        print(f"🚀 [DECODE] GPU (NVDEC) selected for: {metadata.codec_name}")
        input_args = [
            "-threads", "1",
            "-hwaccel", "cuda",
            "-hwaccel_output_format", "cuda",
            "-extra_hw_frames", "8", # Prevents "out of buffers" on 4K
        ]
    else:
        print(f"🛡️ [DECODE] CPU (Hybrid) selected for: {metadata.codec_name}")
        input_args = [
            "-init_hw_device", "cuda=cuda:0",
            "-filter_hw_device", "cuda"
        ]

    # 2. Build Filter Chain
    filters = []

    if metadata.is_hdr:
        print(f"[HDR] Tone mapping {profile.label} (HDR → SDR)")
        if use_gpu_decode:
            # GPU Decode: Frames are already in CUDA memory (likely P010 for HDR)
            filters.extend([
                f"scale_cuda=-2:{profile.height}",
                "tonemap_cuda=tonemap=hable:desat=0:format=nv12"
            ])
        else:
            # CPU Decode: We must upload manually. Use P010 to preserve 10-bit color.
            filters.extend([
                "format=p010le",
                "hwupload",
                f"scale_cuda=-2:{profile.height}",
                "tonemap_cuda=tonemap=hable:desat=0:format=nv12"
            ])
    else:
        # SDR Pipeline
        if use_gpu_decode:
            # GPU Decode: Frames are already in CUDA memory (likely NV12 or YUV420P)
            filters.extend([
                f"scale_cuda=-2:{profile.height}"
            ])
        else:
            # CPU Decode: We must upload manually.
            filters.extend([
                "format=nv12",
                "hwupload",
                f"scale_cuda=-2:{profile.height}"
            ])

    # 3. H.264 Level Logic (Standard)
    if profile.height >= 2160: h264_level = "5.2" if metadata.fps > 30 else "5.1"
    elif profile.height >= 1440: h264_level = "5.1" if metadata.fps > 30 else "5.0"
    elif profile.height >= 1080: h264_level = "4.2" if metadata.fps > 30 else "4.1"
    else: h264_level = "4.0"

    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        
        # --- INPUT STAGE ---
        *input_args,
        "-i", str(input_path),
        
        # --- FILTER STAGE ---
        "-vf", ",".join(filters),
        
        # --- ENCODE STAGE (NVENC) ---
        "-c:v", "h264_nvenc",
        "-preset:v", "p4", 
        "-tune:v", "hq",
        "-rc:v", "vbr",
        
        "-profile:v", "high",
        "-level:v", h264_level,
        
        "-b:v", profile.bitrate,
        "-maxrate:v", profile.maxrate,
        "-bufsize:v", profile.bufsize,
        
        "-g", str(int(SEGMENT_DURATION * metadata.fps)),
        "-keyint_min", str(int(SEGMENT_DURATION * metadata.fps)),
        "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_DURATION})",
        "-sc_threshold", "0",
        
        "-bf", "3",
        "-b_ref_mode", "middle",
        "-an",
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
