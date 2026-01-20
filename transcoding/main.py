import modal
import subprocess
import os
import json
import boto3
from botocore.config import Config
from boto3.s3.transfer import TransferConfig
import shutil
import requests
import ipaddress
import socket
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional, Tuple, Dict, List
from dataclasses import dataclass
import hashlib
import time

app = modal.App("vod-production-pipeline")

S3_CONFIG = Config(
    max_pool_connections=100,
    retries={'max_attempts': 3, 'mode': 'adaptive'}
)

# Multi-threaded transfer config for faster downloads/uploads
TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=8 * 1024 * 1024,   # 8MB - use multipart for files larger than this
    max_concurrency=10,                      # 10 parallel threads
    multipart_chunksize=8 * 1024 * 1024,   # 8MB chunks
    use_threads=True
)

# Production-optimized container
image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("ffmpeg", "wget", "curl", "mediainfo")
    .pip_install("boto3", "requests", "fastapi[standard]", "pillow")
    .run_commands(
        "wget https://github.com/shaka-project/shaka-packager/releases/download/v3.2.0/packager-linux-x64 -O /usr/local/bin/packager",
        "chmod +x /usr/local/bin/packager"
    )
)

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

SEGMENT_DURATION = 4  # 4s segments = faster startup, better ABR
R2_PREFIX = "videos"

@dataclass
class EncodingProfile:
    label: str
    height: int
    bitrate: str
    maxrate: str
    bufsize: str

# Netflix/Mux-style encoding ladder
ENCODING_PROFILES = [
    EncodingProfile("2160p", 2160, "15M", "18M", "30M"),
    EncodingProfile("1440p", 1440, "10M", "12M", "20M"),
    EncodingProfile("1080p", 1080, "5M", "6M", "10M"),
    EncodingProfile("720p", 720, "3M", "3.5M", "6M"),
    EncodingProfile("480p", 480, "1.5M", "1.8M", "3M"),
    EncodingProfile("360p", 360, "800k", "1M", "2M"),
]

ALLOWED_URL_HOSTS = {h.strip().lower() for h in os.getenv("ALLOWED_URL_HOSTS", "").split(",") if h.strip()}

# ═══════════════════════════════════════════════════════════════════════════════
# UTILITY FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

def run_cmd(cmd: list[str], *, label: str = "cmd", check: bool = True) -> subprocess.CompletedProcess:
    """Execute subprocess with timing and error handling."""
    print(f"[CMD] {label}: {' '.join(cmd[:3])}...")
    start = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.time() - start
    
    if check and p.returncode != 0:
        stderr_tail = "\n".join((p.stderr or "").splitlines()[-50:])
        raise RuntimeError(
            f"{label} failed in {elapsed:.1f}s (exit={p.returncode}).\n"
            f"STDERR:\n{stderr_tail}"
        )
    
    print(f"[CMD] {label}: completed in {elapsed:.1f}s")
    return p


def compute_md5(file_path: Path) -> str:
    """Memory-efficient MD5 computation for large files."""
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):  # 64KB chunks
            hash_md5.update(chunk)
    return hash_md5.hexdigest()


def send_callback(url: str, data: dict, max_retries: int = 3):
    """Robust webhook delivery with exponential backoff."""
    print(f"📞 Sending callback to {url}...")
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                url,
                json=data,
                headers={
                    "X-Webhook-Secret": os.environ.get("MODAL_WEBHOOK_SECRET", ""),
                    "Content-Type": "application/json"
                },
                timeout=15
            )
            resp.raise_for_status()
            print(f"✅ Callback delivered: {resp.status_code}")
            return
        except Exception as e:
            if attempt == max_retries - 1:
                print(f"❌ Callback failed after {max_retries} attempts: {e}")
            else:
                wait_time = 2 ** attempt
                print(f"⚠️ Callback attempt {attempt+1} failed. Retrying in {wait_time}s...")
                time.sleep(wait_time)


def is_public_host(url: str) -> bool:
    """SSRF protection: validate URL is HTTPS and resolves to public IP."""
    u = urlparse(url)
    if u.scheme.lower() != "https":
        print(f"[SECURITY] Blocked non-HTTPS URL")
        return False
    
    host = (u.hostname or "").lower()
    if not host:
        return False
    
    if ALLOWED_URL_HOSTS and host not in ALLOWED_URL_HOSTS:
        print(f"[SECURITY] Host not in allowlist: {host}")
        return False
    
    try:
        infos = socket.getaddrinfo(host, None)
        for info in infos:
            addr = info[4][0]
            ip = ipaddress.ip_address(addr)
            if (ip.is_private or ip.is_loopback or ip.is_link_local or 
                ip.is_multicast or ip.is_reserved or ip.is_unspecified):
                print(f"[SECURITY] Blocked private/reserved IP: {ip}")
                return False
    except Exception as e:
        print(f"[SECURITY] DNS resolution failed: {e}")
        return False
    
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# VIDEO ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class VideoMetadata:
    width: int
    height: int
    duration: float
    fps: float
    has_audio: bool
    is_hdr: bool
    
    @property
    def is_vertical(self) -> bool:
        return self.height > self.width
    
    @property
    def aspect_ratio(self) -> str:
        ratio = self.width / self.height if self.height > 0 else 16/9
        return f"{ratio:.2f}:1"


def get_video_metadata(filepath: str) -> VideoMetadata:
    """Extract video metadata using ffprobe."""
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
    Smart ABR ladder selection:
    - No upscaling
    - Skip renditions too close in quality
    - Optimize for vertical video
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


def generate_poster(input_path: str, output_path: str, duration: float):
    """Generate high-quality poster image at 10% timestamp."""
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


# ═══════════════════════════════════════════════════════════════════════════════
# TRANSCODING PIPELINE
# ═══════════════════════════════════════════════════════════════════════════════

def transcode_rendition(
    input_path: Path,
    output_path: Path,
    profile: EncodingProfile,
    metadata: VideoMetadata,
) -> Path:
    """Transcode single video rendition with GPU acceleration."""
    
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
    """Extract and normalize audio track."""
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


# ═══════════════════════════════════════════════════════════════════════════════
# SHAKA PACKAGING
# ═══════════════════════════════════════════════════════════════════════════════

def package_with_shaka(
    renditions: Dict[str, Path],
    output_dir: Path,
    encryption_key: Optional[bytes] = None
) -> None:
    """Package fMP4 files into HLS and DASH manifests."""
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


# ═══════════════════════════════════════════════════════════════════════════════
# UPLOAD TO R2
# ═══════════════════════════════════════════════════════════════════════════════

def upload_to_r2(
    output_dir: Path,
    video_id: str,
    s3_client,
    bucket: str
) -> int:
    """Upload packaged files to R2 with proper metadata."""
    print("☁️ Uploading to R2...")
    
    files = list(output_dir.glob("*"))
    uploaded = 0
    
    def upload_file(file_path: Path) -> bool:
        r2_key = f"{R2_PREFIX}/{video_id}/{file_path.name}"
        
        # Content-Type and Cache-Control mapping
        ext = file_path.suffix.lower()
        content_types = {
            ".m3u8": ("application/vnd.apple.mpegurl", "public, max-age=60"),
            ".mpd": ("application/dash+xml", "public, max-age=60"),
            ".mp4": ("video/mp4", "public, max-age=31536000, immutable"),
            ".m4s": ("video/iso.segment", "public, max-age=31536000, immutable"),
            ".jpg": ("image/jpeg", "public, max-age=31536000, immutable"),
            ".vtt": ("text/vtt", "public, max-age=31536000, immutable"),
            ".key": ("application/octet-stream", "private, no-store, max-age=0"),
        }
        
        content_type, cache_control = content_types.get(
            ext,
            ("application/octet-stream", "public, max-age=3600")
        )
        
        try:
            s3_client.upload_file(
                str(file_path),
                bucket,
                r2_key,
                ExtraArgs={
                    "ContentType": content_type,
                    "CacheControl": cache_control,
                    "Metadata": {
                        "video-id": video_id,
                        "original-name": file_path.name,
                    }
                },
                Config=TRANSFER_CONFIG  # Use multi-threaded uploads too
            )
            return True
        except Exception as e:
            print(f"❌ Upload failed for {file_path.name}: {e}")
            return False
    
    with ThreadPoolExecutor(max_workers=50) as executor:
        results = list(executor.map(upload_file, files))
        uploaded = sum(results)
    
    print(f"✅ Uploaded {uploaded}/{len(files)} files")
    return uploaded


# ═══════════════════════════════════════════════════════════════════════════════
# MODAL ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

@app.function(image=image)
@modal.fastapi_endpoint(method="POST")
def transcode_video(payload: dict):
    """
    Fast HTTP endpoint - spawns GPU worker and returns immediately.
    
    Payload:
      - video_id or fileId (required)
      - {bucket, key} OR input_url (required)
      - callbackUrl (optional)
      - playbackPolicy (optional): "public" or "signed"
    """
    video_id = payload.get("video_id") or payload.get("fileId")
    if not video_id:
        return {"status": "error", "message": "Missing video_id or fileId"}
    
    has_r2 = "key" in payload and "bucket" in payload
    has_url = "input_url" in payload
    
    if not has_r2 and not has_url:
        return {
            "status": "error",
            "message": "Provide either {bucket,key} or input_url"
        }
    
    print(f"🚀 Spawning production worker for: {video_id}")
    transcode_worker.spawn(payload)
    
    return {
        "status": "accepted",
        "video_id": video_id,
        "message": "Transcoding job queued"
    }


@app.function(
    gpu="l4",
    image=image,
    secrets=[modal.Secret.from_name("r2-creds")],
    timeout=3600,  # 1 hour max
    memory=16384,  # 16GB RAM
)
def transcode_worker(payload: dict):
    """GPU worker - executes full transcoding pipeline."""
    video_id = payload.get("video_id") or payload.get("fileId")
    if not video_id:
        return {"status": "error", "message": "Missing video_id"}
    
    work_dir = Path(f"/tmp/{video_id}")
    fmp4_dir = work_dir / "fmp4"
    output_dir = work_dir / "output"
    local_input = work_dir / "input.mp4"
    
    job_start = time.time()
    
    try:
        print(f"🎬 [JOB START] {video_id}")
        
        # ═══════════════════════════════════════════════════════════════════════
        # PREFLIGHT CHECKS
        # ═══════════════════════════════════════════════════════════════════════
        
        # Check available disk space
        disk = shutil.disk_usage("/tmp")
        free_gb = disk.free / (1024**3)
        print(f"💾 Disk space: {free_gb:.2f} GB free")
        
        if free_gb < 10:
            raise RuntimeError(f"Insufficient disk space: {free_gb:.2f} GB (need 10+ GB)")
        
        # Setup working directories
        if work_dir.exists():
            shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True)
        fmp4_dir.mkdir()
        output_dir.mkdir()
        
        # ═══════════════════════════════════════════════════════════════════════
        # DOWNLOAD WITH RETRY
        # ═══════════════════════════════════════════════════════════════════════
        
        downloaded = False
        download_start = time.time()
        
        for attempt in range(3):
            try:
                print(f"⬇️ Download attempt {attempt + 1}/3...")
                
                if "key" in payload and "bucket" in payload:
                    # Download from R2 with multi-threaded transfer
                    s3 = boto3.client(
                        "s3",
                        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                        config=S3_CONFIG,
                    )
                    s3.download_file(
                        payload["bucket"],
                        payload["key"],
                        str(local_input),
                        Config=TRANSFER_CONFIG  # Use multi-threaded downloads
                    )
                
                elif "input_url" in payload:
                    # Download from URL (with SSRF protection)
                    url = payload["input_url"]
                    if not is_public_host(url):
                        raise ValueError("URL blocked by security policy")
                    
                    # Use curl for better performance:
                    # - Faster connection handling
                    # - Better buffer management
                    # - Retry on transient failures
                    run_cmd([
                        "curl",
                        "-fSL",              # fail on HTTP errors, show errors, follow redirects
                        "--retry", "3",       # retry up to 3 times
                        "--retry-delay", "2", # wait 2s between retries
                        "--connect-timeout", "15",
                        "--max-time", "600",  # 10 min max for large files
                        "-o", str(local_input),
                        url
                    ], label="curl-download")
                
                downloaded = True
                break
                
            except Exception as e:
                print(f"⚠️ Download failed: {e}")
                if attempt < 2:
                    time.sleep(2 ** attempt)  # Exponential backoff
        
        if not downloaded:
            raise RuntimeError("Download failed after 3 attempts")
        
        download_time = time.time() - download_start
        file_size_mb = local_input.stat().st_size / (1024 * 1024)
        print(f"✅ Downloaded {file_size_mb:.1f} MB in {download_time:.1f}s")
        
        # ═══════════════════════════════════════════════════════════════════════
        # ANALYZE VIDEO
        # ═══════════════════════════════════════════════════════════════════════
        
        print("🔍 Analyzing video...")
        metadata = get_video_metadata(str(local_input))
        profiles = select_optimal_ladder(metadata)
        
        print(f"📊 Video Info:")
        print(f"   - Resolution: {metadata.width}x{metadata.height} ({metadata.aspect_ratio})")
        print(f"   - Duration: {metadata.duration:.1f}s @ {metadata.fps:.1f}fps")
        print(f"   - Audio: {metadata.has_audio}")
        print(f"   - HDR: {metadata.is_hdr}")
        print(f"   - Vertical: {metadata.is_vertical}")
        
        # ═══════════════════════════════════════════════════════════════════════
        # GENERATE POSTER
        # ═══════════════════════════════════════════════════════════════════════
        
        generate_poster(str(local_input), str(output_dir / "poster.jpg"), metadata.duration)
        
        # ═══════════════════════════════════════════════════════════════════════
        # PARALLEL TRANSCODING
        # ═══════════════════════════════════════════════════════════════════════
        
        transcode_start = time.time()
        
        # Limit workers for 4K to prevent GPU OOM
        max_workers = 4 if metadata.width >= 3840 else 6
        print(f"🎞️ Transcoding with {max_workers} parallel workers...")
        
        renditions = {}
        
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {}
            
            # Submit video renditions
            for profile in profiles:
                output_file = fmp4_dir / f"video_{profile.label}.mp4"
                future = executor.submit(
                    transcode_rendition,
                    local_input,
                    output_file,
                    profile,
                    metadata
                )
                futures[future] = profile.label
            
            # Submit audio if present
            if metadata.has_audio:
                audio_file = fmp4_dir / "audio.mp4"
                audio_future = executor.submit(
                    transcode_audio,
                    local_input,
                    audio_file
                )
                futures[audio_future] = "audio"
            
            # Collect results
            for future in as_completed(futures):
                label = futures[future]
                try:
                    path = future.result()
                    renditions[label] = path
                    print(f"✅ Completed: {label}")
                except Exception as e:
                    print(f"❌ Failed {label}: {e}")
                    raise
        
        transcode_time = time.time() - transcode_start
        processing_speed = metadata.duration / transcode_time if transcode_time > 0 else 0
        print(f"✅ Transcoding complete in {transcode_time:.1f}s ({processing_speed:.2f}x realtime)")
        
        # ═══════════════════════════════════════════════════════════════════════
        # PACKAGE WITH SHAKA
        # ═══════════════════════════════════════════════════════════════════════
        
        package_start = time.time()
        
        playback_policy = payload.get("playbackPolicy", "public")
        encryption_key = os.urandom(16) if playback_policy == "signed" else None
        
        package_with_shaka(renditions, output_dir, encryption_key)
        
        package_time = time.time() - package_start
        print(f"✅ Packaging complete in {package_time:.1f}s")
        
        # ═══════════════════════════════════════════════════════════════════════
        # UPLOAD TO R2
        # ═══════════════════════════════════════════════════════════════════════
        
        upload_start = time.time()
        
        s3_upload = boto3.client(
            "s3",
            endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            config=S3_CONFIG,
        )
        
        uploaded_count = upload_to_r2(
            output_dir,
            video_id,
            s3_upload,
            os.environ["R2_BUCKET_NAME"]
        )
        
        upload_time = time.time() - upload_start
        print(f"✅ Upload complete in {upload_time:.1f}s")
        
        # ═══════════════════════════════════════════════════════════════════════
        # SUCCESS RESPONSE
        # ═══════════════════════════════════════════════════════════════════════
        
        total_time = time.time() - job_start
        
        result = {
            "status": "success",
            "video_id": video_id,
            "metadata": {
                "width": metadata.width,
                "height": metadata.height,
                "duration": metadata.duration,
                "fps": metadata.fps,
                "has_audio": metadata.has_audio,
                "is_hdr": metadata.is_hdr,
                "is_vertical": metadata.is_vertical,
                "aspect_ratio": metadata.aspect_ratio,
            },
            "outputs": {
                "renditions": [p.label for p in profiles],
                "hls_playlist": f"{R2_PREFIX}/{video_id}/playlist.m3u8",
                "dash_manifest": f"{R2_PREFIX}/{video_id}/manifest.mpd",
                "poster": f"{R2_PREFIX}/{video_id}/poster.jpg",
            },
            "processing": {
                "total_time": round(total_time, 2),
                "download_time": round(download_time, 2),
                "transcode_time": round(transcode_time, 2),
                "package_time": round(package_time, 2),
                "upload_time": round(upload_time, 2),
                "processing_speed": round(processing_speed, 2),
                "files_uploaded": uploaded_count,
                "source_size_mb": round(file_size_mb, 2),
            },
            "playback_policy": playback_policy,
            "encrypted": encryption_key is not None,
        }
        
        print(f"✅ [JOB COMPLETE] {video_id} in {total_time:.1f}s ({processing_speed:.2f}x realtime)")
        
        # Send success callback
        if "callbackUrl" in payload:
            send_callback(payload["callbackUrl"], result)
        
        return result
        
    except Exception as e:
        error_time = time.time() - job_start
        print(f"❌ [JOB FAILED] {video_id} after {error_time:.1f}s")
        print(f"Error: {e}")
        
        import traceback
        traceback.print_exc()
        
        error_result = {
            "status": "error",
            "video_id": video_id,
            "message": str(e),
            "error_type": type(e).__name__,
            "processing_time": round(error_time, 2),
        }
        
        # Send error callback
        if "callbackUrl" in payload:
            send_callback(payload["callbackUrl"], error_result)
        
        return error_result
    
    finally:
        # Always cleanup temp files
        if work_dir.exists():
            shutil.rmtree(work_dir, ignore_errors=True)
            print(f"🧹 Cleaned up temp directory")