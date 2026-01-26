"""
VOD Production Pipeline - Modal Endpoints

This is the main entry point for the Modal-based video transcoding service.
All processing logic is organized in separate modules for maintainability.
"""
import sys
from pathlib import Path

# Ensure the current directory is in Python path for Modal deployment
# Modal copies files to /root, so we need to add it to sys.path
_root = Path(__file__).parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

import modal
import os
import shutil
import time
import boto3
from concurrent.futures import ThreadPoolExecutor, as_completed

# Configuration
from config import (
    S3_CONFIG,
    TRANSFER_CONFIG,
    R2_PREFIX,
)

# Utilities
from utils import run_cmd, send_callback, is_public_host
from utils.storage import upload_to_r2

# Video processing
from video import (
    get_video_metadata,
    select_optimal_ladder,
    generate_poster,
    transcode_rendition,
    transcode_audio,
    transcribe_to_vtt,
    generate_chapters,
)

# Packaging
from packaging import package_with_shaka


# ═══════════════════════════════════════════════════════════════════════════════
# MODAL APP CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

app = modal.App("vod-production-pipeline")

# Production-optimized container
image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("ffmpeg", "wget", "curl", "mediainfo")
    .pip_install("boto3", "requests", "fastapi[standard]", "pillow", "faster-whisper", "groq")
    .run_commands(
        "wget https://github.com/shaka-project/shaka-packager/releases/download/v3.2.0/packager-linux-x64 -O /usr/local/bin/packager",
        "chmod +x /usr/local/bin/packager"
    )
    # Add local Python modules
    .add_local_python_source("config")
    .add_local_python_source("utils")
    .add_local_python_source("video")
    .add_local_python_source("packaging")
)


# ═══════════════════════════════════════════════════════════════════════════════
# HTTP ENDPOINT
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


# ═══════════════════════════════════════════════════════════════════════════════
# GPU WORKER
# ═══════════════════════════════════════════════════════════════════════════════

@app.function(
    gpu="l4",
    image=image,
    secrets=[modal.Secret.from_name("r2-creds"), modal.Secret.from_name("groq-creds")],
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
                    print(f"📦 Downloading from R2: {payload['bucket']}/{payload['key']}")
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
                    print(f"🌐 Downloading from URL: {url[:80]}...")
                    if not is_public_host(url):
                        raise ValueError("URL blocked by security policy")
                    
                    # Use curl for better performance with optimized settings
                    run_cmd([
                        "curl",
                        "-fSL",              # fail on HTTP errors, show errors, follow redirects
                        "--retry", "3",       # retry up to 3 times
                        "--retry-delay", "2", # wait 2s between retries
                        "--connect-timeout", "15",
                        "--max-time", "600",  # 10 min max for large files
                        "--tcp-fastopen",     # faster connection setup
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
        # PARALLEL TRANSCODING (+ AI TRANSCRIPTION)
        # ═══════════════════════════════════════════════════════════════════════
        
        transcode_start = time.time()
        
        # Check if we should generate subtitles
        generate_subtitle = payload.get("generateSubtitle", False)
        
        # Dynamically calculate max workers based on decode method and resolution
        # L4 can handle ~3 concurrent NVDEC streams comfortably
        SAFE_GPU_DECODE_CODECS = ["h264", "hevc", "mjpeg", "avc", "avc1"]
        use_gpu_decode = metadata.codec_name.lower() in SAFE_GPU_DECODE_CODECS
        
        if use_gpu_decode:
            # GPU decoding (NVDEC) - limited concurrent streams
            # 4K: 2 workers (NVDEC handles one, leaves headroom)
            # <4K: 3 workers (L4's safe limit for NVDEC)
            max_workers = 2 if metadata.width >= 3840 else 3
            decode_mode = "GPU (NVDEC)"
        else:
            # CPU decoding - can run more parallel jobs
            # 4K: 4 workers (CPU decode + GPU encode)
            # <4K: 6 workers
            max_workers = 4 if metadata.width >= 3840 else 6
            decode_mode = "CPU (Hybrid)"
        
        print(f"🎞️ Transcoding with {max_workers} parallel workers ({decode_mode} decode)...")
        if generate_subtitle:
            print("🎤 AI transcription enabled - will run in parallel")
        
        renditions = {}
        subtitle_path = None
        
        with ThreadPoolExecutor(max_workers=max_workers) as executor, \
             ThreadPoolExecutor(max_workers=2) as audio_executor:
            futures = {}

            # Submit audio if present
            if metadata.has_audio:
                audio_file = fmp4_dir / "audio.mp4"
                audio_future = audio_executor.submit(
                    transcode_audio,
                    local_input,
                    audio_file
                )
                futures[audio_future] = ("audio", "audio")
            
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
                futures[future] = ("video", profile.label)
            
            # Submit AI transcription if requested (runs in parallel!)
            if generate_subtitle and metadata.has_audio:
                subtitle_file = output_dir / "subtitles.vtt"
                transcription_future = executor.submit(
                    transcribe_to_vtt,
                    local_input,
                    subtitle_file,
                    "large-v3-turbo"  # Model size
                )
                futures[transcription_future] = ("subtitle", "subtitles")
            
            # Collect results
            for future in as_completed(futures):
                task_type, label = futures[future]
                try:
                    path = future.result()
                    if task_type == "subtitle":
                        subtitle_path = path
                        print(f"✅ Completed: AI transcription")
                    else:
                        renditions[label] = path
                        print(f"✅ Completed: {label}")
                except Exception as e:
                    if task_type == "subtitle":
                        # Don't fail the whole job if transcription fails
                        print(f"⚠️ AI transcription failed (non-fatal): {e}")
                    else:
                        print(f"❌ Failed {label}: {e}")
                        raise
        
        transcode_time = time.time() - transcode_start
        processing_speed = metadata.duration / transcode_time if transcode_time > 0 else 0
        print(f"✅ Transcoding complete in {transcode_time:.1f}s ({processing_speed:.2f}x realtime)")
        
        # ═══════════════════════════════════════════════════════════════════════
        # AI CHAPTERS GENERATION (after transcription)
        # ═══════════════════════════════════════════════════════════════════════
        
        generate_chapters_flag = payload.get("generateChapters", False)
        chapters_data = None
        
        if generate_chapters_flag and subtitle_path:
            try:
                print("📑 Generating AI chapters from transcript...")
                # Read the VTT content
                with open(subtitle_path, "r", encoding="utf-8") as f:
                    vtt_content = f.read()
                
                # Generate chapters using Groq LLM
                chapters_data = generate_chapters(
                    vtt_content=vtt_content,
                    duration_seconds=metadata.duration,
                )
                
                # Save chapters to JSON file
                chapters_file = output_dir / "chapters.json"
                import json
                with open(chapters_file, "w", encoding="utf-8") as f:
                    json.dump(chapters_data, f, indent=2)
                print(f"✅ Generated {len(chapters_data)} chapters")
                
            except Exception as e:
                # Don't fail the whole job if chapters generation fails
                print(f"⚠️ AI chapters generation failed (non-fatal): {e}")
                chapters_data = None
        
        # ═══════════════════════════════════════════════════════════════════════
        # PACKAGE WITH SHAKA
        # ═══════════════════════════════════════════════════════════════════════
        
        package_start = time.time()
        
        playback_policy = payload.get("playbackPolicy", "public")
        # Note: For "signed" videos, security is enforced at the delivery 
        # worker level via JWT tokens (Mux-style), not content encryption.
        
        package_with_shaka(renditions, output_dir)
        
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
            os.environ["R2_BUCKET_NAME"],
            playback_policy=playback_policy  # For delivery worker auth
        )
        
        upload_time = time.time() - upload_start
        print(f"✅ Upload complete in {upload_time:.1f}s")
        
        # Calculate total transcoded size for billing
        transcoded_size = 0
        for file in output_dir.rglob("*"):
            if file.is_file():
                transcoded_size += file.stat().st_size
        transcoded_size_mb = transcoded_size / (1024 * 1024)
        print(f"📊 Transcoded size: {transcoded_size_mb:.1f} MB ({uploaded_count} files)")
        
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
                "subtitles": f"{R2_PREFIX}/{video_id}/subtitles.vtt" if subtitle_path else None,
            },
            "subtitle": {
                "requested": generate_subtitle,
                "generated": subtitle_path is not None,
                "status": "completed" if subtitle_path else ("failed" if generate_subtitle else None),
                "url": f"{R2_PREFIX}/{video_id}/subtitles.vtt" if subtitle_path else None,
            },
            "chapters": {
                "requested": generate_chapters_flag,
                "generated": chapters_data is not None,
                "status": "completed" if chapters_data else ("failed" if generate_chapters_flag else None),
                "data": chapters_data,
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
                "transcoded_size": transcoded_size,  # bytes - for billing
                "transcoded_size_mb": round(transcoded_size_mb, 2),
            },
            "playback_policy": playback_policy,
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