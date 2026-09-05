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
import re
import secrets
import shutil
import time
import threading
import boto3
from concurrent.futures import ThreadPoolExecutor, as_completed
from fastapi import HTTPException, Request

# Configuration
from config import (
    ALLOWED_SOURCE_BUCKETS,
    ALLOWED_URL_HOSTS,
    S3_CONFIG,
    TRANSFER_CONFIG,
    R2_PREFIX,
)

# Utilities
from utils import send_callback, download_public_url, send_heartbeat

# Typed pipeline errors
from errors import (
    ERROR_AUDIO_ONLY_UNSUPPORTED,
    ERROR_EMPTY_FILE,
    ERROR_INSUFFICIENT_DISK,
    TranscodeError,
    classify_error,
)
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
from packaging import choose_segment_duration, package_with_shaka


# ═══════════════════════════════════════════════════════════════════════════════
# MODAL APP CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

app = modal.App("vod-production-pipeline")

# Production-optimized container
image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("ffmpeg", "wget", "curl", "mediainfo")
    .pip_install("boto3", "requests", "fastapi[standard]", "pillow", "faster-whisper", "groq")
    .env({"HF_HOME": "/root/.cache/huggingface"})
    .run_commands(
        "wget https://github.com/shaka-project/shaka-packager/releases/download/v3.2.0/packager-linux-x64 -O /usr/local/bin/packager",
        "chmod +x /usr/local/bin/packager",
        # Pin v3.2.0 by checksum (supply-chain guard on the image build).
        "printf '%s  /usr/local/bin/packager\\n' 05af2e9ef5f12d58b9d615b7d31dc0eb61c32aee632c71965340b43c1556043e | sha256sum -c -",
        # Pre-bake Whisper weights so cold starts never download ~1.6GB.
        # WHISPER_MODEL=large-v3-turbo (default) maps to this repo.
        "python -c \"from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-large-v3-turbo')\""
    )
    # Add local Python modules
    .add_local_python_source("config")
    .add_local_python_source("utils")
    .add_local_python_source("video")
    .add_local_python_source("packaging")
)

VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def normalize_video_id(raw_video_id: str | None) -> str:
    if not raw_video_id or not isinstance(raw_video_id, str):
        raise ValueError("Missing video_id or fileId")

    video_id = raw_video_id.strip()
    if not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise ValueError(
            "Invalid video_id format (allowed: letters, numbers, '_' and '-')"
        )
    return video_id


def require_ingest_auth(request: Request) -> None:
    expected = (
        os.environ.get("TRANSCODE_INGEST_SECRET")
        or os.environ.get("MODAL_WEBHOOK_SECRET")
    )
    if not expected:
        raise HTTPException(
            status_code=500,
            detail="Server misconfigured: missing TRANSCODE_INGEST_SECRET",
        )

    auth_header = request.headers.get("authorization", "")
    presented = ""
    if auth_header.lower().startswith("bearer "):
        presented = auth_header[7:].strip()

    if not presented:
        presented = request.headers.get("x-transcode-secret", "").strip()

    if not presented or not secrets.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


# ═══════════════════════════════════════════════════════════════════════════════
# HTTP ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════════

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def healthz(request: Request):
    """
    Liveness/health probe for the BYOK setup wizard and uptime checks.
    Optional auth: when TRANSCODE_INGEST_SECRET / MODAL_WEBHOOK_SECRET is set,
    the caller must pass it via x-transcode-secret.
    """
    expected = os.environ.get("TRANSCODE_INGEST_SECRET") or os.environ.get("MODAL_WEBHOOK_SECRET")
    if expected:
        presented = request.headers.get("x-transcode-secret", "")
        if not presented or not secrets.compare_digest(presented, expected):
            raise HTTPException(status_code=401, detail="Unauthorized")
    return {"status": "ok", "service": "openvod-transcoder"}


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("r2-creds")],
)
@modal.fastapi_endpoint(method="POST")
def transcode_video(request: Request, payload: dict):
    """
    Fast HTTP endpoint - spawns GPU worker and returns immediately.
    
    Payload:
      - video_id or fileId (required)
      - {bucket, key} OR input_url (required)
      - callbackUrl (optional)
      - playbackPolicy (optional): "public" or "signed"
    """
    require_ingest_auth(request)

    try:
        video_id = normalize_video_id(payload.get("video_id") or payload.get("fileId"))
    except ValueError as e:
        return {"status": "error", "message": str(e)}
    
    has_r2 = "key" in payload and "bucket" in payload
    has_url = "input_url" in payload
    
    if not has_r2 and not has_url:
        return {
            "status": "error",
            "message": "Provide either {bucket,key} or input_url"
        }

    if has_r2 and ALLOWED_SOURCE_BUCKETS and (payload.get("bucket") or "").lower() not in ALLOWED_SOURCE_BUCKETS:
        return {
            "status": "error",
            "message": f"Bucket '{payload.get('bucket')}' is not in ALLOWED_SOURCE_BUCKETS",
        }

    if has_url and not ALLOWED_URL_HOSTS:
        return {
            "status": "error",
            "message": "input_url is disabled: set ALLOWED_URL_HOSTS to allow URL sources",
        }
    
    safe_payload = dict(payload)
    safe_payload["video_id"] = video_id
    safe_payload["fileId"] = video_id

    print(f"🚀 Spawning production worker for: {video_id}")
    transcode_worker.spawn(safe_payload)
    
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
    try:
        video_id = normalize_video_id(payload.get("video_id") or payload.get("fileId"))
    except ValueError as e:
        return {"status": "error", "message": str(e)}
    
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
        
        if free_gb < 2:
            raise TranscodeError(
                ERROR_INSUFFICIENT_DISK,
                f"Insufficient disk space: {free_gb:.2f} GB free (<2 GB)",
            )
        
        # Setup working directories
        if work_dir.exists():
            shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True)
        fmp4_dir.mkdir()
        output_dir.mkdir()
        
        # ── heartbeat thread (strictly non-fatal) ─────────────────────────
        heartbeat_url = payload.get("heartbeatUrl")
        beat_state = {"stage": "download", "progress": 0.0}
        stop_event = threading.Event()

        def report_stage(stage: str, progress: float) -> None:
            beat_state["stage"] = stage
            beat_state["progress"] = progress
            if heartbeat_url:
                send_heartbeat(heartbeat_url, video_id, stage, progress)

        def _heartbeat_loop() -> None:
            while not stop_event.wait(30):
                if heartbeat_url:
                    send_heartbeat(
                        heartbeat_url, video_id,
                        beat_state["stage"], beat_state["progress"],
                    )

        if heartbeat_url:
            threading.Thread(target=_heartbeat_loop, daemon=True, name="heartbeat").start()
        
        # ═══════════════════════════════════════════════════════════════════════
        # DOWNLOAD WITH RETRY
        # ═══════════════════════════════════════════════════════════════════════
        
        downloaded = False
        download_start = time.time()
        
        for attempt in range(3):
            try:
                print(f"⬇️ Download attempt {attempt + 1}/3...")
                
                if "key" in payload and "bucket" in payload:
                    # Decode exactly once — retry unquoting mangled %xx keys.
                    key_to_use = payload["key"]
                    r2_account_id = os.environ.get("R2_ACCOUNT_ID", "")
                    r2_access_key = os.environ.get("R2_ACCESS_KEY_ID", "")
                    print(f"📦 Downloading from R2: {payload['bucket']}/{key_to_use}")
                    print(f"🔑 R2 Config: Account ID prefix={r2_account_id[:6]}..., Key ID prefix={r2_access_key[:6]}...")
                    
                    if not r2_account_id or not r2_access_key:
                        raise RuntimeError("Missing R2_ACCOUNT_ID or R2_ACCESS_KEY_ID in Modal secrets")

                    # Download from R2 with multi-threaded transfer
                    s3 = boto3.client(
                        "s3",
                        endpoint_url=f"https://{r2_account_id}.r2.cloudflarestorage.com",
                        aws_access_key_id=r2_access_key,
                        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                        config=S3_CONFIG,
                    )
                    s3.download_file(
                        payload["bucket"],
                        key_to_use,
                        str(local_input),
                        Config=TRANSFER_CONFIG  # Use multi-threaded downloads
                    )
                
                elif "input_url" in payload:
                    # Download from URL (with SSRF protection)
                    url = payload["input_url"]
                    if not isinstance(url, str) or not url.strip():
                        raise ValueError("Invalid input_url")
                    url = url.strip()
                    print(f"🌐 Downloading from URL: {url[:80]}...")

                    # Validate and re-validate on every redirect hop.
                    download_public_url(url, str(local_input))
                
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

        # ── post-download preflight ────────────────────────────────────────
        if local_input.stat().st_size <= 1024:
            raise TranscodeError(
                ERROR_EMPTY_FILE,
                f"Downloaded file is {local_input.stat().st_size} bytes — empty/truncated input",
            )

        required_gb = max(4.0, file_size_mb / 1024.0 * 2.2 + 2.0)
        disk_after = shutil.disk_usage("/tmp")
        free_after_gb = disk_after.free / (1024**3)
        if free_after_gb < required_gb:
            raise TranscodeError(
                ERROR_INSUFFICIENT_DISK,
                f"Insufficient disk space: {free_after_gb:.2f} GB free, "
                f"estimated need {required_gb:.2f} GB for a {file_size_mb:.0f} MB source",
            )
        
        # ═══════════════════════════════════════════════════════════════════════
        # ANALYZE VIDEO
        # ═══════════════════════════════════════════════════════════════════════
        
        report_stage("analyze", 0.25)
        print("🔍 Analyzing video...")
        metadata = get_video_metadata(str(local_input))
        is_audio_only = not metadata.has_video
        profiles = [] if is_audio_only else select_optimal_ladder(metadata)
        
        print(f"📊 Video Info:")
        print(f"   - Resolution: {metadata.width}x{metadata.height} ({metadata.aspect_ratio})")
        print(f"   - Duration: {metadata.duration:.1f}s @ {metadata.fps:.1f}fps")
        print(f"   - Audio: {metadata.has_audio}")
        print(f"   - HDR: {metadata.is_hdr}")
        print(f"   - Vertical: {metadata.is_vertical}")
        
        # ═══════════════════════════════════════════════════════════════════════
        # GENERATE POSTER
        # ═══════════════════════════════════════════════════════════════════════
        
        if is_audio_only:
            print("🎧 Audio-only input detected — no video renditions, poster skipped")

        poster_generated = False
        if not is_audio_only:
            try:
                generate_poster(str(local_input), str(output_dir / "poster.jpg"), metadata.duration)
                poster_generated = True
            except Exception as e:
                print(f"⚠️ Poster generation failed (non-fatal): {e}")
        
        # ═══════════════════════════════════════════════════════════════════════
        # PARALLEL TRANSCODING (+ AI TRANSCRIPTION)
        # ═══════════════════════════════════════════════════════════════════════
        
        transcode_start = time.time()
        report_stage("transcode", 0.4)
        
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
                    os.environ.get("WHISPER_MODEL", "large-v3-turbo"),
                    os.environ.get("TRANSCRIBE_LANGUAGE") or None,
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
        report_stage("package", 0.65)
        segment_duration = choose_segment_duration(metadata.duration)
        
        playback_policy = payload.get("playbackPolicy", "public")
        organization_id = payload.get("organizationId")
        # Note: For "signed" videos, security is enforced at the delivery 
        # worker level via JWT tokens (Mux-style), not content encryption.
        
        package_with_shaka(renditions, output_dir, segment_duration=segment_duration)
        
        package_time = time.time() - package_start
        print(f"✅ Packaging complete in {package_time:.1f}s")

        # Progressive staging cleanup: fMP4 intermediates are no longer needed
        # once Shaka has written its segments — reclaim disk before upload.
        if fmp4_dir.exists():
            shutil.rmtree(fmp4_dir, ignore_errors=True)
            print(f"🧹 Cleaned fMP4 staging ({fmp4_dir})")
        
        # ═══════════════════════════════════════════════════════════════════════
        # UPLOAD TO R2
        # ═══════════════════════════════════════════════════════════════════════
        
        upload_start = time.time()
        report_stage("upload", 0.85)
        
        s3_upload = boto3.client(
            "s3",
            endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            config=S3_CONFIG,
        )
        
        upload_stats = upload_to_r2(
            output_dir,
            video_id,
            s3_upload,
            os.environ["R2_BUCKET_NAME"],
            playback_policy=playback_policy,
            organization_id=organization_id,
        )
        uploaded_count = upload_stats.uploaded
        if not upload_stats.complete:
            failed_preview = ", ".join(upload_stats.failed[:10])
            raise TranscodeError(
                ERROR_PARTIAL_UPLOAD,
                f"Uploaded {upload_stats.uploaded}/{upload_stats.total} files "
                f"(failed: {failed_preview or 'unknown'})",
            )
        
        upload_time = time.time() - upload_start
        print(f"✅ Upload complete in {upload_time:.1f}s")
        
        # Calculate total transcoded size for usage metering
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
                "poster": f"{R2_PREFIX}/{video_id}/poster.jpg" if poster_generated else None,
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
                "status": (
                    "completed"
                    if chapters_data
                    else (
                        "skipped"
                        if generate_chapters_flag and not subtitle_path
                        else ("failed" if generate_chapters_flag else None)
                    )
                ),
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
                "transcoded_size": transcoded_size,  # bytes - usage metering
                "transcoded_size_mb": round(transcoded_size_mb, 2),
            },
            "playback_policy": playback_policy,
        }
        
        print(f"✅ [JOB COMPLETE] {video_id} in {total_time:.1f}s ({processing_speed:.2f}x realtime)")
        report_stage("complete", 1.0)
        
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
            "error_code": classify_error(e),
            "processing_time": round(error_time, 2),
        }
        
        # Send error callback
        if "callbackUrl" in payload:
            send_callback(payload["callbackUrl"], error_result)
        
        return error_result
    
    finally:
        # Stop the heartbeat thread
        stop_event.set()

        # Always cleanup temp files
        if work_dir.exists():
            shutil.rmtree(work_dir, ignore_errors=True)
            print(f"🧹 Cleaned up temp directory")
