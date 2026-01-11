import modal
import subprocess
import os
import json
import boto3
import shutil
import requests
import ipaddress
import socket
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

app = modal.App("vod-hls-pipeline")

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("ffmpeg", "wget", "curl")
    .pip_install("boto3", "requests")
)

# --- CONFIGURATION ---
# HLS segment length (seconds)
HLS_TIME = 6

# Where you want outputs to live in R2
R2_PREFIX = "videos"  # videos/{video_id}/...

STANDARD_LADDER = {
    "2160p": {"h": 2160, "b": "15M",  "max": "17M",  "buf": "22M"},
    "1440p": {"h": 1440, "b": "10M",  "max": "12M",  "buf": "15M"},
    "1080p": {"h": 1080, "b": "5M",   "max": "6M",   "buf": "7.5M"},
    "720p":  {"h": 720,  "b": "3M",   "max": "3.5M", "buf": "4.5M"},
    "480p":  {"h": 480,  "b": "1.5M", "max": "1.8M", "buf": "2.5M"},
    "360p":  {"h": 360,  "b": "800k", "max": "900k", "buf": "1.2M"},
}

# Optional: comma-separated allowed hosts for input_url (e.g. "cdn.myapp.com,storage.googleapis.com")
# If empty/unset, we allow any PUBLIC host over https (still blocks private/reserved IPs).
ALLOWED_URL_HOSTS = {h.strip().lower() for h in os.getenv("ALLOWED_URL_HOSTS", "").split(",") if h.strip()}


def run_cmd(cmd: list[str], *, label: str = "cmd") -> subprocess.CompletedProcess:
    """
    Run a subprocess and capture stdout/stderr for debugging.
    On failure, raises with a compact error message including tail of stderr.
    """
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        stderr_tail = "\n".join((p.stderr or "").splitlines()[-80:])
        stdout_tail = "\n".join((p.stdout or "").splitlines()[-40:])
        raise RuntimeError(
            f"{label} failed (exit={p.returncode}).\n"
            f"COMMAND: {' '.join(cmd)}\n\n"
            f"STDERR (tail):\n{stderr_tail}\n\n"
            f"STDOUT (tail):\n{stdout_tail}"
        )
    return p


def is_public_host(url: str) -> bool:
    """
    Basic SSRF mitigation:
    - require https
    - optional host allowlist (if ALLOWED_URL_HOSTS is set)
    - resolve DNS and block private/reserved/link-local loopback, etc.
    """
    u = urlparse(url)
    if u.scheme.lower() != "https":
        return False

    host = (u.hostname or "").lower()
    if not host:
        return False

    if ALLOWED_URL_HOSTS and host not in ALLOWED_URL_HOSTS:
        return False

    try:
        # Resolve and validate all A/AAAA records
        infos = socket.getaddrinfo(host, None)
        for info in infos:
            addr = info[4][0]
            ip = ipaddress.ip_address(addr)
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_reserved
                or ip.is_unspecified
            ):
                return False
    except Exception:
        return False

    return True


def get_stream_info(filepath: str) -> tuple[int, bool]:
    """Returns (height, has_audio)."""
    try:
        cmd = ["ffprobe", "-v", "error", "-show_streams", "-of", "json", filepath]
        p = run_cmd(cmd, label="ffprobe(streams)")
        data = json.loads(p.stdout)

        height = 1080
        has_audio = False

        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video":
                height = int(stream.get("height", 1080))
            elif stream.get("codec_type") == "audio":
                has_audio = True

        return height, has_audio
    except Exception:
        return 1080, False  # fallback


def get_video_duration(filepath: str) -> float:
    """Returns duration in seconds (float)."""
    try:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            filepath,
        ]
        p = run_cmd(cmd, label="ffprobe(duration)")
        return float(p.stdout.strip())
    except Exception:
        return 0.0


def generate_thumbnail(input_path: str, out_path: str, duration: float) -> None:
    """
    Generate a thumbnail JPG.
    Picks a timestamp around 10% into the video (clamped).
    """
    # Pick a good timestamp
    if duration and duration > 0:
        ts = max(1.0, min(10.0, duration * 0.10))
    else:
        ts = 1.0

    # Scale for a decent preview. Keep aspect, ensure width divisible by 2.
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-ss",
        f"{ts:.3f}",
        "-i",
        input_path,
        "-frames:v",
        "1",
        "-an",
        "-vf",
        "scale=1280:-2",
        "-q:v",
        "2",
        out_path,
    ]
    run_cmd(cmd, label="ffmpeg(thumbnail)")


@app.function(
    gpu="l4",
    image=image,
    secrets=[modal.Secret.from_name("r2-creds")],
    timeout=1800,
)
@modal.web_endpoint(method="POST")
def transcode_video(payload: dict):
    """
    Expected payload:
      - video_id OR fileId (required - used as the output folder name)
      - {bucket, key} OR input_url (required)
      - callbackUrl (optional)
    """
    video_id = payload.get("video_id") or payload.get("fileId")
    if not video_id:
        return {"status": "error", "message": "Missing video_id or fileId"}

    work_dir = Path(f"/tmp/{video_id}")
    output_dir = work_dir / "output"
    local_input = work_dir / "input.mp4"

    s3 = None
    targets = []
    duration = 0.0
    has_audio = False
    input_height = 1080

    try:
        print(f"🎬 Starting Job for: {video_id}")

        # Clean workspace
        if work_dir.exists():
            shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        # --- DOWNLOAD ---
        if "key" in payload and "bucket" in payload:
            s3 = boto3.client(
                "s3",
                endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            )
            s3.download_file(payload["bucket"], payload["key"], str(local_input))

        elif "input_url" in payload:
            url = payload["input_url"]
            if not is_public_host(url):
                return {"status": "error", "message": "input_url blocked (must be https and public/allowed host)"}
            run_cmd(["wget", "-q", url, "-O", str(local_input)], label="wget(download)")

        else:
            return {"status": "error", "message": "Provide either {bucket,key} or input_url"}

        # --- ANALYZE ---
        input_height, has_audio = get_stream_info(str(local_input))
        duration = get_video_duration(str(local_input))

        # Choose ladder targets (no upscaling)
        for label, settings in STANDARD_LADDER.items():
            if settings["h"] <= input_height:
                targets.append((label, settings))
        targets.sort(key=lambda x: x[1]["h"], reverse=True)
        if not targets:
            targets.append(("360p", STANDARD_LADDER["360p"]))

        print(f"📐 Input height: {input_height} | Audio: {has_audio} | Duration: {duration:.2f}s")
        print(f"🎚️ Generating renditions: {[t[0] for t in targets]}")

        # --- THUMBNAIL ---
        thumb_path = output_dir / "thumbnail.jpg"
        generate_thumbnail(str(local_input), str(thumb_path), duration)

        # --- FFMPEG (HLS) ---
        cmd = ["ffmpeg", "-hide_banner", "-y", "-i", str(local_input)]

        # Split + scale in one decode pass
        filter_complex = f"[0:v]split={len(targets)}"
        filter_complex += "".join([f"[v{i}]" for i in range(len(targets))]) + ";"
        for i, (_, settings) in enumerate(targets):
            # -2 keeps AR and ensures divisible-by-2 width for H.264
            filter_complex += f"[v{i}]scale=-2:{settings['h']}[out{i}];"
        cmd.extend(["-filter_complex", filter_complex])

        # Build HLS var_stream_map
        var_stream_map_parts = []

        for i, (_, settings) in enumerate(targets):
            # Force keyframes exactly at segment boundaries for cleaner ABR switching,
            # regardless of input FPS / VFR weirdness.
            force_kf_expr = f"expr:gte(t,n_forced*{HLS_TIME})"

            cmd.extend(
                [
                    "-map",
                    f"[out{i}]",

                    # Video encode (GPU)
                    f"-c:v:{i}",
                    "h264_nvenc",

                    # Quality / RC tuning (good MVP defaults)
                    f"-preset:v:{i}",
                    "p4",
                    f"-rc:v:{i}",
                    "vbr_hq",

                    # Compatibility
                    f"-pix_fmt:v:{i}",
                    "yuv420p",
                    f"-profile:v:{i}",
                    "high",

                    # Rate control
                    f"-b:v:{i}",
                    settings["b"],
                    f"-maxrate:v:{i}",
                    settings["max"],
                    f"-bufsize:v:{i}",
                    settings["buf"],

                    # GOP / keyframes
                    f"-force_key_frames:v:{i}",
                    force_kf_expr,
                    f"-sc_threshold:v:{i}",
                    "0",
                ]
            )

            if has_audio:
                var_stream_map_parts.append(f"v:{i},agroup:audio")
            else:
                var_stream_map_parts.append(f"v:{i}")

        # Audio (single shared track) only if present
        if has_audio:
            cmd.extend(
                [
                    "-map",
                    "a:0",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-ac",
                    "2",
                    "-ar",
                    "48000",
                ]
            )
            var_stream_map_parts.append(
                "a:0,agroup:audio,default:yes,language:eng,name:English"
            )

        # HLS packaging
        cmd.extend(
            [
                "-f",
                "hls",
                "-hls_time",
                str(HLS_TIME),
                "-hls_playlist_type",
                "vod",
                "-hls_flags",
                "independent_segments",
                "-master_pl_name",
                "playlist.m3u8",
                "-hls_segment_filename",
                f"{output_dir}/stream_%v_data%03d.ts",
                "-var_stream_map",
                " ".join(var_stream_map_parts),
                f"{output_dir}/stream_%v.m3u8",
            ]
        )

        run_cmd(cmd, label="ffmpeg(hls)")

        # --- UPLOAD ---
        print("☁️ Uploading...")

        s3_upload = boto3.client(
            "s3",
            endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        )

        files = sorted(os.listdir(output_dir))

        def upload_file(filename: str):
            local_path = output_dir / filename
            r2_key = f"{R2_PREFIX}/{video_id}/{filename}"

            if filename.endswith(".m3u8"):
                content_type = "application/vnd.apple.mpegurl"
                cache_control = "public, max-age=60"  # playlists: short cache
            elif filename.endswith(".ts"):
                content_type = "video/mp2t"
                cache_control = "public, max-age=31536000, immutable"  # segments: long cache
            elif filename.endswith(".jpg") or filename.endswith(".jpeg"):
                content_type = "image/jpeg"
                cache_control = "public, max-age=31536000, immutable"
            else:
                content_type = "application/octet-stream"
                cache_control = "public, max-age=31536000, immutable"

            s3_upload.upload_file(
                str(local_path),
                os.environ["R2_BUCKET_NAME"],
                r2_key,
                ExtraArgs={
                    "ContentType": content_type,
                    "CacheControl": cache_control,
                },
            )

        with ThreadPoolExecutor(max_workers=10) as executor:
            list(executor.map(upload_file, files))

        # --- CALLBACK ---
        if "callbackUrl" in payload:
            try:
                print(f"📞 Calling Webhook: {payload['callbackUrl']}")
                requests.post(
                    payload["callbackUrl"],
                    json={
                        "status": "success",
                        "video_id": video_id,
                        "fileId": payload.get("fileId"),
                        "resolutions": [t[0] for t in targets],
                        "duration": duration,
                        "master_playlist": f"{R2_PREFIX}/{video_id}/playlist.m3u8",
                        "thumbnail": f"{R2_PREFIX}/{video_id}/thumbnail.jpg",
                        "file_count": len(files),
                    },
                    timeout=10,
                )
            except Exception as e:
                print(f"❌ Callback failed: {e}")

        # --- RETURN (better payload) ---
        return {
            "status": "success",
            "video_id": video_id,
            "resolutions": [t[0] for t in targets],
            "duration": duration,
            "master_playlist": f"{R2_PREFIX}/{video_id}/playlist.m3u8",
            "thumbnail": f"{R2_PREFIX}/{video_id}/thumbnail.jpg",
            "file_count": len(files),
            "has_audio": has_audio,
            "input_height": input_height,
        }

    except Exception as e:
        print(f"❌ Job failed: {e}")
        return {"status": "error", "video_id": video_id, "message": str(e)}

    finally:
        # Always cleanup
        try:
            if work_dir.exists():
                shutil.rmtree(work_dir)
        except Exception:
            pass
