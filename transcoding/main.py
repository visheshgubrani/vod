"""
VOD Production Pipeline — Modal endpoints.

This module is now only the *Modal adapter*. It owns the things that are
genuinely Modal's: the image, the HTTP ingest endpoint, the container-level
duplicate suppression, and the GPU worker's resource request. Everything else —
probing, planning, encoding, packaging, validation, inventory — is in
`clipmux_transcoder`, which is the same code a local worker runs.

That split is the point of the extraction: a fix to rendition planning or to
output validation lands in both environments at once, and cannot drift.
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
from fastapi import HTTPException, Request

# Keep build helpers independent of this module's pipeline imports.
from image_build import (
    download_whisper_weights,
    read_package_list,
    resolve_toolchain_file,
)

# The shared engine. Imported here so `modal deploy` fails loudly if the
# package does not hydrate, rather than at the first job.
from clipmux_transcoder import (
    CancellationToken,
    ProcessingOptions,
    classify_error,
    run_pipeline,
)
from clipmux_transcoder.config import (
    R2_PREFIX,
    allowed_source_buckets,
    allowed_url_hosts,
    config_warnings,
)
from clipmux_transcoder.errors import ERROR_INSUFFICIENT_DISK, TranscodeError
from clipmux_transcoder.progress import CallbackProgress, ProgressBeat
from clipmux_transcoder.transfer.s3 import S3Transfer, client_from_env
from clipmux_transcoder.utils import send_callback, send_heartbeat


# ═══════════════════════════════════════════════════════════════════════════════
# MODAL APP CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

app = modal.App("vod-production-pipeline")

_config_warned = False


def _emit_config_warnings_once() -> None:
    """Log allowlist gaps inside the container, where clipmux-creds is injected.

    Do not call this at module import: `modal deploy` imports this file on the
    laptop, which has no Modal secret env, and the warnings are a false alarm.
    """
    global _config_warned
    if _config_warned:
        return
    _config_warned = True
    for warning in config_warnings():
        print(f"[CONFIG] {warning}", flush=True)


# Durable duplicate suppression for transcode attempts.
#
# Keyed by the API's attempt id, written before a worker is spawned. Shared
# across containers, so it survives the ingest container being recycled between
# a lost dispatch response and the retry that follows it.
attempts = modal.Dict.from_name("transcode-attempts", create_if_missing=True)

# How long an "accepted" marker suppresses a repeat delivery. Long enough to
# cover the API's dispatch retries; short enough that a crash between recording
# and spawning costs one retry rather than the job.
ATTEMPT_MARKER_TTL_SECONDS = int(os.environ.get("ATTEMPT_MARKER_TTL_SECONDS", "300"))


# ── the shared media toolchain ───────────────────────────────────────────────
#
# One recipe, two images. `transcoding/toolchain/build_ffmpeg.sh` builds the
# pinned FFmpeg 9.0.1 here and in the local worker image
# (`Dockerfile.agent`), so the bytes a Modal worker produces and the bytes an
# agent produces come from the same binary. `versions.env` is the only place a
# version, URL or digest is written down.
#
# Why not the distribution's FFmpeg: the deployed build's `scale_cuda` rejects
# the `format` option the NVIDIA scaling path passes, which is a build-time
# property of FFmpeg's CUDA filters. The recipe builds them with clang
# (`--enable-cuda-llvm`), so the option exists — and the engine no longer depends
# on it for the hybrid path either.
_TOOLCHAIN_DIR = _root / "toolchain"
# Where the *container* finds the same directory. `main.py` and `image_build.py`
# are mounted as loose files at /root, so `_TOOLCHAIN_DIR` above is empty inside
# a container; the `add_local_dir(copy=True)` below bakes the recipe here
# instead. Reading the checkout path unconditionally is what made the deployed
# app fail hydration with '/root/toolchain/apt-packages.env' — so the two paths
# are named, and `resolve_toolchain_file` picks the one that exists.
_TOOLCHAIN_IN_IMAGE = "/opt/clipmux/toolchain"
_CUDA_BASE_REF = (
    "nvidia/cuda:12.9.2-cudnn-runtime-ubuntu24.04"
    "@sha256:070f8f2672df1b05b84c0409a5fd1d54ddfd646e5b9d8dee7878131271b563fc"
)

# The build-time and runtime package lists are shared with Dockerfile.agent.
# Read through the resolver, not `_TOOLCHAIN_DIR`: this module executes at
# container start too, not only on the deploy machine.
_APT_PACKAGES = resolve_toolchain_file("apt-packages.env")
_BUILD_PACKAGES = read_package_list(_APT_PACKAGES, "CLIPMUX_BUILD_PACKAGES")
_RUNTIME_PACKAGES = read_package_list(_APT_PACKAGES, "CLIPMUX_RUNTIME_PACKAGES")

# CUDA 12.9 + cuDNN 9 runtime base, pinned by manifest digest: faster-whisper's
# CTranslate2 backend wants CUDA 12 and cuDNN 9, and a floating tag is a silent
# toolchain change on the next build. The toolkit is deliberately absent — the
# CUDA *filters* are compiled to PTX by clang, and the driver is reached by
# dlopen at runtime, which is why hardware usability is probed at runtime.
image = (
    modal.Image.from_registry(_CUDA_BASE_REF, add_python="3.12")
    .entrypoint([])
    .apt_install(*_BUILD_PACKAGES, *_RUNTIME_PACKAGES, "mediainfo")
    .add_local_dir(str(_TOOLCHAIN_DIR), remote_path=_TOOLCHAIN_IN_IMAGE, copy=True)
    .run_commands(
        # Build, then prove: version, codecs, filters, the `format` option of
        # `scale_cuda`, and a real CPU encode. A broken toolchain fails the
        # image build instead of the first job after a deploy. The path comes
        # from `_TOOLCHAIN_IN_IMAGE` so the build, the verification and the
        # container's reader cannot disagree about where the recipe landed.
        f"bash {_TOOLCHAIN_IN_IMAGE}/build_ffmpeg.sh /usr/local",
        f"bash {_TOOLCHAIN_IN_IMAGE}/verify_toolchain.sh"
        " /usr/local/bin/ffmpeg /usr/local/bin/ffprobe",
        # Shaka Packager, checksum-pinned: a packager that changes version
        # changes the bytes every job produces.
        "curl -fsSL https://github.com/shaka-project/shaka-packager/releases/download/v3.2.0/packager-linux-x64 -o /usr/local/bin/packager"
        " && chmod +x /usr/local/bin/packager"
        " && printf '%s  /usr/local/bin/packager\\n' 05af2e9ef5f12d58b9d615b7d31dc0eb61c32aee632c71965340b43c1556043e | sha256sum -c -",
    )
    .pip_install_from_requirements(str(_TOOLCHAIN_DIR / "requirements-managed.lock"))
    .env({"HF_HOME": "/root/.cache/huggingface"})
    .run_function(download_whisper_weights, timeout=60 * 60)
    # The engine package is mounted as a package, not as loose modules: that is
    # what lets `clipmux_transcoder.encoding.backends` resolve inside the
    # container, and what stops the shared modules shadowing third-party ones.
    .add_local_python_source("clipmux_transcoder", "image_build")
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
    return {"status": "ok", "service": "clipmux-transcoder"}


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name(
            "clipmux-creds",
            # Asserted at deploy time: a secret missing one of these would
            # otherwise surface as a 500 on the first upload or, worse, as an
            # empty allowlist that silently accepts any bucket.
            required_keys=[
                "TRANSCODE_INGEST_SECRET",
                "ALLOWED_SOURCE_BUCKETS",
                "ALLOWED_CALLBACK_HOSTS",
            ],
        )
    ],
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
      - attempt_id (required by the API): identifies the owning attempt

    Duplicate suppression
    ---------------------
    The API's dispatcher retries a POST whose response was lost. Without
    suppression that retry spawns a *second* GPU container for the same video:
    two encodes, two uploads to the same prefix, and the tenant billed twice.

    So an accepted `attempt_id` is recorded before the worker spawns, and a
    repeat delivery of the same id returns without spawning. The API holds the
    same id across its retries for exactly this reason.

    The marker carries a timestamp and is only honoured while it is *fresh*. A
    marker with no expiry would turn a crash between "record accepted" and
    "spawn worker" into a permanently suppressed job: the retry would see the
    marker, skip, and the video would never encode. A marker older than
    `ATTEMPT_MARKER_TTL_SECONDS` is treated as a failed accept and the retry is
    allowed through.

    Residual windows, stated rather than papered over:
      - `modal.Dict` is not an atomic compare-and-set, so two genuinely
        simultaneous requests carrying one attempt id could both pass. The API
        only retries after the previous request failed, so they are not
        simultaneous in practice.
      - If the dedupe store is unreachable we log loudly and continue, because
        failing closed would stop all transcoding on a Dict outage. The API's
        attempt claim is the primary guard; this is defence in depth.
    """
    require_ingest_auth(request)
    _emit_config_warnings_once()

    try:
        video_id = normalize_video_id(payload.get("video_id") or payload.get("fileId"))
    except ValueError as e:
        return {"status": "error", "message": str(e)}

    attempt_id = str(payload.get("attempt_id") or payload.get("attemptId") or "").strip()

    has_r2 = "key" in payload and "bucket" in payload
    has_url = "input_url" in payload
    
    if not has_r2 and not has_url:
        return {
            "status": "error",
            "message": "Provide either {bucket,key} or input_url"
        }

    # Defense in depth on the ingest boundary: the API is the only intended
    # caller, but a leaked ingest secret must not turn into "read any bucket
    # under the R2 credentials" or "fetch any URL".
    source_buckets = allowed_source_buckets()
    url_hosts = allowed_url_hosts()
    if has_r2 and source_buckets and (payload.get("bucket") or "").lower() not in source_buckets:
        return {
            "status": "error",
            "message": f"Bucket '{payload.get('bucket')}' is not in ALLOWED_SOURCE_BUCKETS",
        }

    if has_url and not url_hosts:
        return {
            "status": "error",
            "message": "input_url is disabled: set ALLOWED_URL_HOSTS to allow URL sources",
        }

    # Suppress a repeat delivery of an attempt we already accepted. Recorded
    # BEFORE the spawn so a retry arriving mid-spawn is also suppressed.
    if attempt_id:
        try:
            seen = attempts.get(attempt_id)
        except Exception as e:
            seen = None
            print(f"[WARN] Dedupe store unreachable, proceeding: {e}")

        if isinstance(seen, dict):
            age = time.time() - float(seen.get("ts") or 0)
            if age < ATTEMPT_MARKER_TTL_SECONDS:
                print(f"♻️ Duplicate attempt {attempt_id} for {video_id}: not spawning again")
                return {
                    "status": "duplicate",
                    "video_id": video_id,
                    "attempt_id": attempt_id,
                    "message": "Attempt already accepted; not started again",
                }
            # Stale marker: the previous accept never produced a worker (the
            # process died between recording and spawning). Let the retry run.
            print(
                f"[WARN] Stale attempt marker for {attempt_id} "
                f"({age:.0f}s > {ATTEMPT_MARKER_TTL_SECONDS}s): retrying rather than suppressing"
            )

        try:
            attempts[attempt_id] = {
                "video_id": video_id,
                "state": "accepted",
                "ts": time.time(),
            }
        except Exception as e:
            # A dedupe-store outage must not block transcoding outright; the API's
            # attempt claim is still the primary guard.
            print(f"[WARN] Could not record attempt {attempt_id}: {e}")

    safe_payload = dict(payload)
    safe_payload["video_id"] = video_id
    safe_payload["fileId"] = video_id
    if attempt_id:
        safe_payload["attempt_id"] = attempt_id

    print(f"🚀 Spawning production worker for: {video_id} (attempt {attempt_id or 'unidentified'})")
    transcode_worker.spawn(safe_payload)
    
    return {
        "status": "accepted",
        "video_id": video_id,
        "attempt_id": attempt_id or None,
        "message": "Transcoding job queued"
    }


# ═══════════════════════════════════════════════════════════════════════════════
# GPU WORKER
# ═══════════════════════════════════════════════════════════════════════════════

@app.function(
    gpu="l4",
    image=image,
    secrets=[
        modal.Secret.from_name(
            "clipmux-creds",
            required_keys=[
                "R2_BUCKET_NAME",
                "TRANSCODE_INGEST_SECRET",
                "ALLOWED_SOURCE_BUCKETS",
                "ALLOWED_CALLBACK_HOSTS",
            ],
        ),
        # Required to exist even when AI subtitles are skipped; the wizard
        # creates it with a dummy value.
        modal.Secret.from_name("clipmux-groq-creds"),
    ],
    timeout=3600,  # 1 hour max
    memory=16384,  # 16GB RAM
    # Four cores are enough for three GPU renditions plus a software fallback;
    # the eight-core limit stops a CPU-only job from starving the container it
    # shares with the GPU paths.
    cpu=(4, 8),
)
def transcode_worker(payload: dict):
    """GPU worker - executes the shared pipeline and reports the outcome."""
    _emit_config_warnings_once()
    try:
        video_id = normalize_video_id(payload.get("video_id") or payload.get("fileId"))
    except ValueError as e:
        return {"status": "error", "message": str(e)}

    work_dir = Path(f"/tmp/{video_id}")
    local_input = work_dir / "input.mp4"
    attempt_id = str(payload.get("attempt_id") or "").strip()
    job_start = time.time()

    # ── heartbeat thread (strictly non-fatal) ─────────────────────────────
    heartbeat_url = payload.get("heartbeatUrl")
    # Every beat names its attempt: the API ignores a beat from an attempt
    # that no longer owns the row, and extends the lease of one that does.
    beat_state = {"stage": "download", "progress": 0.0}
    stop_event = threading.Event()

    # The engine reports every second per encoder and the ladder encodes its
    # renditions concurrently, so forwarding each update as a beat meant four
    # requests a second — each one a server write that only renewed a lease
    # measured in minutes. Beats are coalesced; the state above is not, so the
    # liveness thread always carries the freshest stage and progress.
    beat = ProgressBeat()

    def report_stage(stage: str, progress: float) -> None:
        beat_state["stage"] = stage
        beat_state["progress"] = progress
        if heartbeat_url and beat.should_send(stage):
            send_heartbeat(heartbeat_url, video_id, stage, progress, attempt_id)

    def _heartbeat_loop() -> None:
        while not stop_event.wait(30):
            if heartbeat_url:
                send_heartbeat(
                    heartbeat_url, video_id,
                    beat_state["stage"], beat_state["progress"],
                    attempt_id,
                )

    if heartbeat_url:
        threading.Thread(target=_heartbeat_loop, daemon=True, name="heartbeat").start()

    token = CancellationToken()
    try:
        print(f"🎬 [JOB START] {video_id}")

        work_dir.mkdir(parents=True, exist_ok=True)
        _preflight_disk(work_dir)

        # ── download (the Modal input is already immutable: a fresh download
        #    into an ephemeral container, so no local snapshot is needed) ────
        download_start = time.time()
        _download_source(payload, local_input)
        download_time = time.time() - download_start
        file_size_mb = local_input.stat().st_size / (1024 * 1024)
        print(f"✅ Downloaded {file_size_mb:.1f} MB in {download_time:.1f}s")

        required_gb = max(4.0, file_size_mb / 1024.0 * 2.2 + 2.0)
        free_after_gb = shutil.disk_usage("/tmp").free / (1024**3)
        if free_after_gb < required_gb:
            raise TranscodeError(
                ERROR_INSUFFICIENT_DISK,
                f"Insufficient disk space: {free_after_gb:.2f} GB free, "
                f"estimated need {required_gb:.2f} GB for a {file_size_mb:.0f} MB source",
            )

        options = _options_from_payload(payload, video_id, attempt_id)

        # Progress → heartbeat. The engine's 0..1 scale is what the API stores,
        # so the Modal path and the agent path report identical numbers.
        def on_progress(update) -> None:
            report_stage(update.stage, update.overall)

        s3 = client_from_env()
        transfer = S3Transfer(
            s3,
            os.environ["R2_BUCKET_NAME"],
            prefix=R2_PREFIX,
            # Legacy layout on purpose: existing Modal videos, in-flight
            # attempts and already-issued playback URLs all reference
            # `videos/<id>/`, and changing it would strand them.
            key_root=f"{R2_PREFIX}/{video_id}",
            video_id=video_id,
            playback_policy=options.playback_policy,
            organization_id=options.organization_id,
        )

        result = run_pipeline(
            local_input,
            work_dir / "job",
            options,
            None,  # capabilities: probed by the engine at entry
            CallbackProgress(on_progress),
            token,
            transfer=transfer,
            ffmpeg="ffmpeg",
            packager="packager",
        )

        result.metadata.timings.setdefault("download", round(download_time, 2))
        # Rebase onto the key layout this worker actually uploaded to. The API
        # handles a Modal callback with rebasing *off* (it has no attempt prefix
        # to rebase against), so output-relative paths would be saved as
        # `<delivery>/playlist.m3u8` — a URL that 404s for every viewer.
        response = result.as_payload(key_prefix=f"{R2_PREFIX}/{video_id}")
        response["processing"]["total_time"] = round(time.time() - job_start, 2)

        print(
            f"✅ [JOB COMPLETE] {video_id} in {response['processing']['total_time']:.1f}s "
            f"({response['processing']['processing_speed']:.2f}x realtime)"
        )
        report_stage("complete", 1.0)

        if "callbackUrl" in payload:
            send_callback(payload["callbackUrl"], response)

        return response

    except Exception as e:
        error_time = time.time() - job_start
        print(f"❌ [JOB FAILED] {video_id} after {error_time:.1f}s")
        print(f"Error: {e}")

        import traceback
        traceback.print_exc()

        error_result = {
            "status": "error",
            "video_id": video_id,
            "attempt_id": attempt_id,
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


# ═══════════════════════════════════════════════════════════════════════════════
# WORKER HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _preflight_disk(work_dir: Path) -> None:
    free_gb = shutil.disk_usage(str(work_dir)).free / (1024**3)
    print(f"💾 Disk space: {free_gb:.2f} GB free")
    if free_gb < 2:
        raise TranscodeError(
            ERROR_INSUFFICIENT_DISK,
            f"Insufficient disk space: {free_gb:.2f} GB free (<2 GB)",
        )


def _download_source(payload: dict, local_input: Path) -> None:
    """Fetch the source from R2 or a public URL, with retry."""
    from clipmux_transcoder.utils import download_public_url

    last_error: Exception | None = None
    for attempt in range(3):
        try:
            print(f"⬇️ Download attempt {attempt + 1}/3...")
            if "key" in payload and "bucket" in payload:
                from clipmux_transcoder.transfer.s3 import transfer_config

                s3 = client_from_env()
                print(f"📦 Downloading from R2: {payload['bucket']}/{payload['key']}")
                s3.download_file(
                    payload["bucket"],
                    payload["key"],
                    str(local_input),
                    Config=transfer_config(),
                )
            else:
                url = payload["input_url"]
                if not isinstance(url, str) or not url.strip():
                    raise ValueError("Invalid input_url")
                print(f"🌐 Downloading from URL: {url[:80]}...")
                # Validate and re-validate on every redirect hop.
                download_public_url(url.strip(), str(local_input))
            return
        except Exception as e:  # noqa: BLE001 — retried below, then reported
            last_error = e
            print(f"⚠️ Download failed: {e}")
            if attempt < 2:
                time.sleep(2 ** attempt)  # Exponential backoff

    raise RuntimeError(f"Download failed after 3 attempts: {last_error}")


def _options_from_payload(payload: dict, video_id: str, attempt_id: str) -> ProcessingOptions:
    """
    Build the immutable option set from the dispatch payload.

    The Modal path keeps the legacy rendition policy so its output stays
    byte-identical: existing installations are mid-flight during a rolling
    upgrade, and a silently different ladder would strand their playback URLs.
    """
    return ProcessingOptions.from_dict({
        "video_id": video_id,
        "attempt_id": attempt_id,
        "playback_policy": payload.get("playbackPolicy", "public"),
        "organization_id": payload.get("organizationId"),
        "generate_subtitle": bool(payload.get("generateSubtitle", False)),
        "generate_chapters": bool(payload.get("generateChapters", False)),
        "transcribe_language": os.environ.get("TRANSCRIBE_LANGUAGE") or None,
        "whisper_model": os.environ.get("WHISPER_MODEL", "large-v3-turbo"),
        "rendition_policy": "legacy",
        "encoder_backend": os.environ.get("TRANSCODE_ENCODER", "auto"),
        # The engine no longer hard-codes L4-sized concurrency; the Modal
        # worker asks for what it actually has.
        "rendition_concurrency": int(os.environ.get("TRANSCODE_RENDITION_CONCURRENCY", "3")),
        # Three GPU renditions stay the default. A CPU-only job (or one that fell
        # back to the CPU) runs one rendition at a time with four threads: N x264
        # encodes in parallel contend for the same four cores and finish later
        # than the same work run in sequence. Hybrid encodes decode and scale in
        # software, so they get a smaller bound of their own; audio gets one
        # thread, because it is never the bottleneck.
        "cpu_rendition_concurrency": int(os.environ.get("TRANSCODE_CPU_RENDITION_CONCURRENCY", "1")),
        "cpu_ffmpeg_threads": int(os.environ.get("TRANSCODE_CPU_THREADS", "4")),
        "hybrid_ffmpeg_threads": int(os.environ.get("TRANSCODE_HYBRID_THREADS", "2")),
        "audio_ffmpeg_threads": int(os.environ.get("TRANSCODE_AUDIO_THREADS", "1")),
        "audio_concurrency": 1,
        "upload_concurrency": 10,
    })
