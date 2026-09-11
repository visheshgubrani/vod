"""
Configuration constants and encoding profiles for the VOD transcoding pipeline.

Importing this module must never require Modal, CUDA, boto3, R2 credentials or
Whisper: those belong to the optional seams (transfer, encoding, enrichment) and
are imported lazily by the code that actually uses them. The shared engine is
imported by the Modal runner, the self-hosted agent and the CLI alike, and on a
fresh machine none of the optional extras need to be installed for the package
to import and plan work.
"""
import os
from dataclasses import dataclass
from typing import Set


# ═══════════════════════════════════════════════════════════════════════════════
# TRANSCODING CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

SEGMENT_DURATION = 4  # 4s segments = faster startup, better ABR
R2_PREFIX = "videos"

# Bumped whenever the rendition plan or packaging layout changes meaningfully.
# Reusable work (snapshots, encoded renditions) is keyed by the source hash and
# this value, so a plan change invalidates caches instead of mixing outputs
# produced under two different rules.
PROCESSING_PLAN_VERSION = 1


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

# The v1 self-hosted default: an adaptive ladder that stops at 1080p. 1440p and
# 2160p stay available but must be asked for explicitly.
DEFAULT_MAX_HEIGHT = 1080
DEFAULT_RUNG_HEIGHTS = (360, 480, 720, 1080)
OPTIONAL_RUNG_HEIGHTS = (1440, 2160)

# Renditions must never be closer than this in height — two rungs 10% apart cost
# a full encode each and give the player nothing to choose between.
LADDER_MIN_HEIGHT_GAP = 0.15


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
# Source R2 buckets the ingest endpoint accepts (payload {bucket,key}).
# When unset, any bucket under the R2 credentials is accepted — set it to
# your raw upload bucket for defense in depth.
#   ALLOWED_SOURCE_BUCKETS=raw-bucket-uploads
ALLOWED_SOURCE_BUCKETS: Set[str] = {
    h.strip().lower()
    for h in os.getenv("ALLOWED_SOURCE_BUCKETS", "").split(",")
    if h.strip()
}

ALLOWED_CALLBACK_HOSTS: Set[str] = {
    h.strip().lower()
    for h in os.getenv("ALLOWED_CALLBACK_HOSTS", "").split(",")
    if h.strip()
}

def config_warnings() -> list[str]:
    """
    Non-fatal misconfigurations worth saying out loud, once, at startup.

    Returned rather than printed: importing a configuration module must not write
    to stdout. The Modal runner calls this explicitly (it is the deployment where
    both settings matter); the self-hosted agent does not, because neither
    callback allowlist is used on that path.
    """
    warnings: list[str] = []
    if not ALLOWED_SOURCE_BUCKETS:
        warnings.append(
            "ALLOWED_SOURCE_BUCKETS is not set: ingest payloads may reference any "
            "bucket under the R2 credentials. Set it to your raw upload bucket "
            "(e.g. ALLOWED_SOURCE_BUCKETS=raw-bucket-uploads)."
        )
    if not ALLOWED_CALLBACK_HOSTS:
        warnings.append(
            "ALLOWED_CALLBACK_HOSTS is not set: transcode-complete callbacks will "
            "only be delivered to localhost. Set it to your API host (e.g. "
            "ALLOWED_CALLBACK_HOSTS=api.yourdomain.com) in the Modal "
            "environment/secrets, otherwise jobs complete but the server never "
            "learns about it."
        )
    return warnings
