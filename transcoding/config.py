"""
Configuration constants and encoding profiles for the VOD transcoding pipeline.
"""
import os
from dataclasses import dataclass
from typing import Set

from botocore.config import Config
from boto3.s3.transfer import TransferConfig


# ═══════════════════════════════════════════════════════════════════════════════
# S3/R2 CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

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


# ═══════════════════════════════════════════════════════════════════════════════
# TRANSCODING CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

SEGMENT_DURATION = 4  # 4s segments = faster startup, better ABR
R2_PREFIX = "videos"


@dataclass
class EncodingProfile:
    """Encoding profile for a single rendition."""
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


# ═══════════════════════════════════════════════════════════════════════════════
# SECURITY CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

ALLOWED_URL_HOSTS: Set[str] = {
    h.strip().lower() 
    for h in os.getenv("ALLOWED_URL_HOSTS", "").split(",") 
    if h.strip()
}

# Callback destinations (the API's /api/webhook/transcode-complete URL).
# NO DEFAULT HOSTS: when unset, callbacks are restricted to localhost and the
# pipeline logs loudly. Set this to your API host, e.g.
#   ALLOWED_CALLBACK_HOSTS=api.yourdomain.com
# (comma-separated, lower-cased).
ALLOWED_CALLBACK_HOSTS: Set[str] = {
    h.strip().lower()
    for h in os.getenv("ALLOWED_CALLBACK_HOSTS", "").split(",")
    if h.strip()
}

if not ALLOWED_CALLBACK_HOSTS:
    print(
        "[CONFIG] ALLOWED_CALLBACK_HOSTS is not set: transcode-complete "
        "callbacks will only be delivered to localhost. Set it to your API "
        "host (e.g. ALLOWED_CALLBACK_HOSTS=api.yourdomain.com) in the Modal "
        "environment/secrets, otherwise jobs complete but the server never "
        "learns about it.",
        flush=True,
    )
