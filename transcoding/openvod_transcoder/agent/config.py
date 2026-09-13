"""
Agent configuration: what this machine is allowed to read, and how much of it.

Loaded from a TOML-free, dependency-free format (JSON, or environment variables
for a container), because the agent must install and start on a machine with
nothing but Python and FFmpeg.

Two settings carry more weight than the rest:

- **`roots`** is the complete list of directories the agent may read. It is the
  only source of authority in the whole agent: `PathPolicy` resolves and checks
  containment against exactly these, and nothing else in the codebase may open a
  file by an owner-supplied path.
- **`scratch_dir`** is where snapshots and work directories live. It must be on
  the same volume as the originals for reflinks to work, and it must be large
  enough for the estimate in `snapshot.estimate_scratch_bytes` — which is checked
  before a job starts rather than discovered at 90%.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from openvod_transcoder.paths import Root

DEFAULT_SCRATCH = "/var/lib/openvod-transcoder/scratch"
DEFAULT_JOURNAL = "/var/lib/openvod-transcoder/journal.sqlite"
DEFAULT_ROOTS_FILE = "/etc/openvod-transcoder/roots.json"


@dataclass
class AgentConfig:
    api_url: str = "http://localhost:8787"
    token: str = ""
    name: str = ""
    roots: List[Root] = field(default_factory=list)
    scratch_dir: Path = Path(DEFAULT_SCRATCH)
    journal_path: Path = Path(DEFAULT_JOURNAL)
    encoder_backend: str = "auto"
    encoder_device: Optional[str] = None
    capacity_jobs: int = 1
    capacity_renditions: int = 1
    # Uploads run concurrently because they are network-bound, while encoding
    # stays at one rendition unless the operator says otherwise.
    upload_concurrency: int = 4
    heartbeat_seconds: float = 30.0
    poll_seconds: float = 5.0
    stall_timeout_seconds: float = 900.0
    # Failed work is kept for a week by default: long enough to investigate, short
    # enough not to fill a laptop.
    failed_retention_days: int = 7
    scratch_quota_bytes: Optional[int] = None
    whisper_model: str = "large-v3-turbo"
    transcribe_language: Optional[str] = None

    def validate(self) -> List[str]:
        """Human-readable problems. `doctor` prints these; `run` refuses to start."""
        problems: List[str] = []
        if not self.api_url:
            problems.append('api_url is not set (pass --api or set OPENVOD_API_URL)')
        if not self.token:
            problems.append('no agent token (run "openvod-transcoder pair" first)')
        if not self.roots:
            problems.append(
                'no readable folders are configured: set OPENVOD_ROOTS to a '
                'comma-separated list, or provide a roots file. The agent will '
                'not read anything outside these.'
            )
        for root in self.roots:
            if not root.path.exists():
                problems.append(f'configured folder does not exist: {root.name}')
        if self.capacity_jobs < 1:
            problems.append('capacity_jobs must be at least 1')
        if self.capacity_renditions < 1:
            problems.append('capacity_renditions must be at least 1')
        return problems

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> "AgentConfig":
        values = env if env is not None else os.environ
        roots = _parse_roots(values)

        return cls(
            api_url=(
                values.get("OPENVOD_API_URL")
                or values.get("OPENVOD_API")
                or "http://localhost:8787"
            ).rstrip("/"),
            token=values.get("OPENVOD_AGENT_TOKEN", ""),
            name=values.get("OPENVOD_AGENT_NAME", ""),
            roots=roots,
            scratch_dir=Path(values.get("OPENVOD_SCRATCH_DIR") or DEFAULT_SCRATCH),
            journal_path=Path(values.get("OPENVOD_JOURNAL") or DEFAULT_JOURNAL),
            encoder_backend=values.get("OPENVOD_ENCODER", "auto"),
            encoder_device=values.get("OPENVOD_ENCODER_DEVICE") or None,
            capacity_jobs=_int(values.get("OPENVOD_CAPACITY_JOBS"), 1),
            capacity_renditions=_int(values.get("OPENVOD_CAPACITY_RENDITIONS"), 1),
            upload_concurrency=_int(values.get("OPENVOD_UPLOAD_CONCURRENCY"), 4),
            heartbeat_seconds=_float(values.get("OPENVOD_HEARTBEAT_SECONDS"), 30.0),
            poll_seconds=_float(values.get("OPENVOD_POLL_SECONDS"), 5.0),
            stall_timeout_seconds=_float(values.get("OPENVOD_STALL_TIMEOUT_SECONDS"), 900.0),
            failed_retention_days=_int(values.get("OPENVOD_FAILED_RETENTION_DAYS"), 7),
            scratch_quota_bytes=_optional_int(values.get("OPENVOD_SCRATCH_QUOTA_BYTES")),
            whisper_model=values.get("WHISPER_MODEL", "large-v3-turbo"),
            transcribe_language=values.get("TRANSCRIBE_LANGUAGE") or None,
        )


def _parse_roots(values: dict) -> List[Root]:
    """
    Read the readable-folder list.

    Accepts `name:path` pairs from `OPENVOD_ROOTS` (comma-separated) or a JSON
    file at `OPENVOD_ROOTS_FILE`. The name is what the dashboard shows; the path
    is what the policy enforces against, and it never leaves this machine.
    """
    raw = values.get("OPENVOD_ROOTS", "")
    roots: List[Root] = []
    for entry in str(raw).split(","):
        item = entry.strip()
        if not item:
            continue
        name, _, path = item.partition(":")
        if not path:
            path = name
            name = Path(path).name or "media"
        roots.append(Root(name=name.strip(), path=Path(path.strip())))

    if roots:
        return roots

    roots_file = values.get("OPENVOD_ROOTS_FILE", DEFAULT_ROOTS_FILE)
    if roots_file and Path(roots_file).exists():
        try:
            payload = json.loads(Path(roots_file).read_text())
        except (OSError, json.JSONDecodeError):
            return []
        entries = payload.get("roots") if isinstance(payload, dict) else payload
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict) and entry.get("path"):
                    roots.append(
                        Root(
                            name=str(entry.get("name") or Path(str(entry["path"])).name),
                            path=Path(str(entry["path"])),
                        )
                    )
    return roots


def _int(value, fallback: int) -> int:
    try:
        parsed = int(value)
        return parsed if parsed > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def _optional_int(value) -> Optional[int]:
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def _float(value, fallback: float) -> float:
    try:
        parsed = float(value)
        return parsed if parsed > 0 else fallback
    except (TypeError, ValueError):
        return fallback
