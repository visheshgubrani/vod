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
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Set


# ═══════════════════════════════════════════════════════════════════════════════
# TRANSCODING CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

SEGMENT_DURATION = 4  # 4s segments = faster startup, better ABR
R2_PREFIX = "videos"

# Bumped whenever the rendition plan, packaging layout or execution paths change
# meaningfully. Reusable work (snapshots, encoded renditions) is keyed by the
# source hash and this value, so a plan change invalidates caches instead of
# mixing outputs produced under two different rules.
#
# v2: verified execution paths. Renditions are now selected per source from real
#     preflight results, the hybrid NVENC path no longer runs `scale_cuda`, and
#     each rendition records the backend and mode that produced it. Work encoded
#     under v1 must not be reused inside a v2 job.
PROCESSING_PLAN_VERSION = 2

# Identity of the shared engine, recorded with every job so a completed video can
# be traced back to the code that produced it.
ENGINE_VERSION = "1.1.0"


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
#
# Read from the *current* environment at call time. Snapshotting at import
# makes `modal deploy` warn on the laptop (no r2-creds in that process) and
# can freeze an empty allowlist into a running container.

def _csv_set(value: str) -> Set[str]:
    return {
        host.strip().lower()
        for host in value.split(",")
        if host.strip()
    }


def _env_csv(name: str, env: Mapping[str, str] | None = None) -> Set[str]:
    mapping = os.environ if env is None else env
    raw = mapping.get(name, "") or ""
    return _csv_set(raw)


def allowed_url_hosts(env: Mapping[str, str] | None = None) -> Set[str]:
    return _env_csv("ALLOWED_URL_HOSTS", env)


def allowed_source_buckets(env: Mapping[str, str] | None = None) -> Set[str]:
    """Source R2 buckets the ingest endpoint accepts (payload {bucket,key}).

    When empty, any bucket under the R2 credentials is accepted — set it to
    the raw upload bucket for defense in depth.
    """
    return _env_csv("ALLOWED_SOURCE_BUCKETS", env)


def allowed_callback_hosts(env: Mapping[str, str] | None = None) -> Set[str]:
    """Callback destinations (the API's /api/webhook/transcode-complete URL).

    When empty, callbacks are restricted to localhost. Set this to your API
    host, e.g. ALLOWED_CALLBACK_HOSTS=api.yourdomain.com (comma-separated).
    """
    return _env_csv("ALLOWED_CALLBACK_HOSTS", env)


def config_warnings(env: Mapping[str, str] | None = None) -> list[str]:
    """
    Non-fatal misconfigurations worth saying out loud, once, at container start.

    Returned rather than printed: importing a configuration module must not write
    to stdout. Call this from the Modal function body (where r2-creds is
    injected), not at module import during `modal deploy` on the laptop.
    """
    warnings: list[str] = []
    if not allowed_source_buckets(env):
        warnings.append(
            "ALLOWED_SOURCE_BUCKETS is not set: ingest payloads may reference any "
            "bucket under the R2 credentials. Set it to your raw upload bucket "
            "(e.g. ALLOWED_SOURCE_BUCKETS=raw-bucket-uploads)."
        )
    if not allowed_callback_hosts(env):
        warnings.append(
            "ALLOWED_CALLBACK_HOSTS is not set: transcode-complete callbacks will "
            "only be delivered to localhost. Set it to your API host (e.g. "
            "ALLOWED_CALLBACK_HOSTS=api.yourdomain.com) in the Modal "
            "environment/secrets, otherwise jobs complete but the server never "
            "learns about it."
        )
    return warnings
