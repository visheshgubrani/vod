"""
Source-specific short preflight, and capability detection backed by real encodes.

Three things this module deliberately does *not* do:

1. **Trust `ffmpeg -hwaccels`.** It lists compile-time support. The device node
   may not exist, the container may not have been given the render group, the
   driver may be older than the codec, or every NVENC session may be in use.
2. **Trust a synthetic startup test alone.** A `testsrc` encode proves the
   encoder works; it cannot prove that *this* source's pixel format, bit depth,
   chroma location or resolution is accepted by that encoder's hardware path.
   The preflight encodes the first seconds of the actual file for exactly this
   reason.
3. **Probe the whole chain as one thing.** Decode, filter and encode fail for
   different reasons and have different remedies, so each is tested separately
   and reported separately. That is what lets the fallback policy drop
   hardware *decode* while keeping hardware *encode*, instead of collapsing to
   CPU because one link is broken.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

from openvod_transcoder.encoding.backends import (
    ALL_BACKENDS,
    BACKEND_CPU,
    BACKEND_NVENC,
    BACKEND_VAAPI,
    EncoderBackend,
    RenderSpec,
    SourceTraits,
    build_video_command,
    even,
    h264_level,
    input_args,
    source_gpu_path_supported,
)
from openvod_transcoder.encoding.failures import (
    classify_ffmpeg_stderr,
    probe_verdict_for_kind,
)

def classify_probe_failure(stderr: str) -> str:
    """
    Map FFmpeg stderr onto a probe verdict.

    Pure, and checked against literals: the strings below are copied from real
    FFmpeg output rather than invented, because the whole point of the module is
    to stop guessing about hardware.

    Delegates to the shared classifier in
    :mod:`openvod_transcoder.encoding.failures`, so a message means the same
    thing here as it does at the encoding boundary. Keeping two tables would be
    how "the probe said the GPU was fine" and "the encode failed on the GPU"
    drift apart.
    """
    return probe_verdict_for_kind(classify_ffmpeg_stderr(stderr))


@dataclass
class EncoderProbe:
    """Whether one backend can encode, and if not, why."""
    backend: str
    available: bool
    reason: str = ""
    failure_kind: str = ""
    detail: str = ""


@dataclass
class ChainProbe:
    """
    Decode / filter / encode probed separately for one backend and one source.

    ``hardware_decode`` and ``hardware_filters`` are the *verified* answers: they
    are only true when a real decode-and-filter of this source succeeded on the
    device. ``hardware_encode`` is the weaker, more important claim — the
    encoder itself accepted this source's frames — and it is what lets the
    pipeline keep a hardware encoder while dropping the hardware filter path.
    The pipeline uses these to decide between a full hardware path, a hybrid
    (software decode → hardware encode) and the CPU, rather than assuming either.
    """
    backend: str
    hardware_encode: bool = False
    hardware_decode: bool = False
    hardware_filters: bool = False
    reason: str = ""
    detail: str = ""


@dataclass
class CapabilityReport:
    """What this machine can actually do, as reported to the API."""
    ffmpeg: str = ""
    shaka: str = ""
    compiled_hwaccels: List[str] = field(default_factory=list)
    encoders: Dict[str, EncoderProbe] = field(default_factory=dict)
    cpu_cores: int = 0
    memory_bytes: int = 0
    scratch_free_bytes: int = 0
    detected_at: float = field(default_factory=time.time)

    def available_backends(self) -> List[str]:
        return [name for name, probe in self.encoders.items() if probe.available]

    def to_payload(self) -> dict:
        """Wire form. Never contains host paths, only the backend *name*."""
        return {
            "ffmpeg": self.ffmpeg,
            "shaka": self.shaka,
            "hwaccels": list(self.compiled_hwaccels),
            "encoders": {
                name: {"available": probe.available, "reason": probe.reason}
                for name, probe in sorted(self.encoders.items())
            },
            "cpuCores": self.cpu_cores,
            "memoryBytes": self.memory_bytes,
            "scratchFreeBytes": self.scratch_free_bytes,
            "probedAt": int(self.detected_at),
        }


# ── inventory: what the binary claims ────────────────────────────────────────

# Six flag characters, then the encoder name. The name must start with an
# identifier character so the `V..... = Video` legend block does not parse as
# an encoder called "=".
_ENCODER_LINE = re.compile(r"^\s*[A-Z.]{6}\s+([A-Za-z0-9_][\w.+-]*)\s", re.MULTILINE)


def parse_encoder_list(output: str) -> List[str]:
    """Encoder names from `ffmpeg -encoders` output."""
    return sorted({match.group(1) for match in _ENCODER_LINE.finditer(output or "")})


def parse_hwaccels(output: str) -> List[str]:
    """Accelerator names from `ffmpeg -hwaccels` (one per line after the header)."""
    names = []
    for line in (output or "").splitlines():
        entry = line.strip()
        if not entry or entry.lower().startswith("hardware acceleration"):
            continue
        if entry.isidentifier():
            names.append(entry.lower())
    return sorted(set(names))


def ffmpeg_version(output: str) -> str:
    """First line of `ffmpeg -version`, trimmed to something loggable."""
    first = (output or "").strip().splitlines()
    return first[0][:120] if first else ""


def binary_available(name: str) -> bool:
    return shutil.which(name) is not None


# ── real probes ──────────────────────────────────────────────────────────────

# 1 frame of black at the smallest useful size: fast enough to run at startup,
# large enough that a broken encoder cannot pass by accident.
SYNTHETIC_SOURCE_ARGS = [
    "-f", "lavfi",
    "-i", "color=c=black:s=320x240:r=25:d=0.2",
    "-frames:v", "2",
]

PROBE_TIMEOUT_SECONDS = 120

# Preflight is per *job*, not once per machine, so it is bounded twice over:
# a sample of a couple of seconds, and a hard timeout. A source on a slow
# network mount must not be able to hold a worker hostage at startup.
PREFLIGHT_SECONDS = 1.5
PREFLIGHT_FRAMES = 8
PREFLIGHT_TIMEOUT_SECONDS = 60.0


def synthetic_command(ffmpeg: str, backend: EncoderBackend) -> List[str]:
    """Command that encodes two black frames with ``backend``."""
    spec = RenderSpec(
        label="probe",
        width=320,
        height=240,
        bitrate="500k",
        maxrate="600k",
        bufsize="1M",
        fps=25.0,
    )
    if backend.name == BACKEND_CPU:
        filters = "scale=320:240,setsar=1"
        encoder_args = ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", "500k"]
    elif backend.name == BACKEND_NVENC:
        filters = None  # no filter: probe the raw encoder first
        encoder_args = ["-c:v", backend.codec, "-preset:v", "p4", "-b:v", "500k"]
    else:
        filters = None
        encoder_args = ["-c:v", backend.codec, "-b:v", "500k"]

    args = [ffmpeg, "-hide_banner", "-loglevel", "error"]
    if backend.name == BACKEND_VAAPI:
        args += [
            "-init_hw_device", f"vaapi=va:{backend.device}",
            "-filter_hw_device", "va",
            "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25:d=0.2",
            "-vf", "format=nv12,hwupload",
        ]
    else:
        args += SYNTHETIC_SOURCE_ARGS
        if filters:
            args += ["-vf", filters]
    return args + encoder_args + ["-f", "null", "-"]


def probe_backend(
    backend: EncoderBackend,
    *,
    ffmpeg: str = "ffmpeg",
    run: Callable[..., subprocess.CompletedProcess] | None = None,
    timeout: float = PROBE_TIMEOUT_SECONDS,
) -> EncoderProbe:
    """
    Encode two synthetic frames with ``backend`` and report the truth.

    Runs a real process on purpose. Anything cheaper has been observed to say
    "yes" on machines where the encode then fails, which is precisely the
    failure this module exists to prevent.
    """
    executor = run or subprocess.run
    cmd = synthetic_command(ffmpeg, backend)
    try:
        completed = executor(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return EncoderProbe(
            backend=backend.name,
            available=False,
            reason="probe timed out",
            failure_kind="session-exhausted",
        )
    except FileNotFoundError:
        return EncoderProbe(
            backend=backend.name,
            available=False,
            reason=f"{ffmpeg} not found",
            failure_kind="device-unavailable",
        )

    if completed.returncode == 0:
        return EncoderProbe(backend=backend.name, available=True)

    stderr = completed.stderr or ""
    kind = classify_probe_failure(stderr)
    return EncoderProbe(
        backend=backend.name,
        available=False,
        reason=f"encode probe failed ({kind})",
        failure_kind=kind,
        detail="\n".join(stderr.strip().splitlines()[-5:]),
    )


def preflight_command(
    source_path: Path,
    metadata: SourceTraits,
    backend: EncoderBackend,
    *,
    spec: Optional[RenderSpec] = None,
    ffmpeg: str = "ffmpeg",
    gpu_decode: bool,
    duration: float = PREFLIGHT_SECONDS,
    frames: int = PREFLIGHT_FRAMES,
) -> List[str]:
    """
    The preflight command for one path, built by the *production* builder.

    Using :func:`build_video_command` rather than a hand-written probe command is
    the point: the probe must exercise the encoder arguments, filter chain and
    container flags the job will really use, or it verifies something else. The
    only edits are the bound (``-t`` and ``-frames:v``) and the destination
    (``-f null -``), both appended where the output file would have gone.
    """
    resolved = spec or _default_preflight_spec(metadata)
    cmd = build_video_command(
        ffmpeg=ffmpeg,
        input_path=str(source_path),
        output_path="-",
        backend=backend,
        spec=resolved,
        metadata=metadata,
        segment_duration=duration,
        gpu_decode=gpu_decode,
    )
    # `cmd` ends with the output path; replace it with a bounded null sink so the
    # probe writes nothing and cannot be mistaken for a rendition.
    return [
        *cmd[:-1],
        "-t", f"{duration:.2f}",
        "-frames:v", str(max(1, frames)),
        "-f", "null", "-",
    ]


def preflight_source(
    source_path: Path,
    metadata: SourceTraits,
    backend: EncoderBackend,
    *,
    spec: Optional[RenderSpec] = None,
    ffmpeg: str = "ffmpeg",
    run: Callable[..., subprocess.CompletedProcess] | None = None,
    duration: float = PREFLIGHT_SECONDS,
    timeout: float = PREFLIGHT_TIMEOUT_SECONDS,
) -> ChainProbe:
    """
    Encode the first ``duration`` seconds of the real source on this backend.

    This is where "the encoder works" becomes "the encoder works *for this
    file*": pixel format, bit depth, chroma location and resolution limits are
    all properties of the source, and a synthetic probe cannot see any of them.

    Two paths are tried, and both are built by the production command builder at
    the *planned rendition dimensions* — the size the job will really scale to:

    1. full GPU (GPU decode + GPU filter + GPU encode), skipped entirely when the
       source's own properties rule it out (see
       :func:`~openvod_transcoder.encoding.backends.source_gpu_path_supported`);
    2. hybrid (software decode and filter, hardware encode) — the same NVENC
       encode without ``scale_cuda``, which is the path that recovers from the
       filter failure this module was extended for.

    Decode, filter and encode are reported separately so the caller can keep
    hardware *encoding* while falling back to software decode.
    """
    executor = run or subprocess.run
    timeout = min(timeout, PREFLIGHT_TIMEOUT_SECONDS)

    attempts: List[tuple[str, bool]] = []
    if source_gpu_path_supported(metadata):
        attempts.append(("hardware", True))
    attempts.append(("hybrid", False))

    last: ChainProbe = ChainProbe(backend=backend.name, reason="preflight did not run")
    for mode, gpu_decode in attempts:
        cmd = preflight_command(
            source_path, metadata, backend,
            spec=spec, ffmpeg=ffmpeg, gpu_decode=gpu_decode, duration=duration,
        )
        try:
            completed = executor(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            last = ChainProbe(
                backend=backend.name,
                reason=f"{mode} path timed out after {timeout:.0f}s",
            )
            continue
        except FileNotFoundError:
            return ChainProbe(backend=backend.name, reason=f"{ffmpeg} not found")

        if completed.returncode == 0:
            return ChainProbe(
                backend=backend.name,
                hardware_encode=True,
                hardware_decode=(mode == "hardware"),
                hardware_filters=(mode == "hardware"),
                reason="ok" if mode == "hardware" else "hardware encode only (software decode)",
            )

        kind = classify_probe_failure(completed.stderr or "")
        last = ChainProbe(
            backend=backend.name,
            reason=f"{mode} path failed ({kind})",
            detail="\n".join((completed.stderr or "").strip().splitlines()[-5:]),
        )

    return last


def _default_preflight_spec(metadata: SourceTraits) -> RenderSpec:
    """A small stand-in spec for callers that have not planned renditions yet."""
    return RenderSpec(
        label="preflight",
        width=max(2, even(min(320, getattr(metadata, "width", 0) or 320))),
        height=max(2, even(min(240, getattr(metadata, "height", 0) or 240))),
        bitrate="500k",
        maxrate="600k",
        bufsize="1M",
        fps=min(getattr(metadata, "fps", 0.0) or 25.0, 30.0),
    )


def detect_capabilities(
    *,
    ffmpeg: str = "ffmpeg",
    shaka: str = "packager",
    scratch_dir: Path | None = None,
    run: Callable[..., subprocess.CompletedProcess] | None = None,
    probe: bool = True,
) -> CapabilityReport:
    """
    Build the report the agent sends to the API.

    ``probe=False`` returns the inventory only (no encodes) — useful for a fast
    start where the full probe is deliberately deferred, and for tests.
    """
    executor = run or subprocess.run
    report = CapabilityReport()

    if binary_available(ffmpeg):
        try:
            version = executor([ffmpeg, "-version"], capture_output=True, text=True, timeout=30)
            report.ffmpeg = ffmpeg_version(version.stdout or "")
            encoders = executor([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=30)
            listed = parse_encoder_list(encoders.stdout or "")
            hwaccels = executor([ffmpeg, "-hide_banner", "-hwaccels"], capture_output=True, text=True, timeout=30)
            report.compiled_hwaccels = parse_hwaccels(hwaccels.stdout or "")
        except Exception as exc:  # noqa: BLE001 — an inventory failure is reported, not raised
            report.ffmpeg = ""
            listed = []
            print(f"[CAPS] ffmpeg inventory failed: {exc}")
    else:
        listed = []

    if binary_available(shaka):
        try:
            version = executor([shaka, "--version"], capture_output=True, text=True, timeout=30)
            report.shaka = (version.stdout or version.stderr or "").strip().splitlines()[0][:120]
        except Exception:  # noqa: BLE001
            report.shaka = "unknown"

    report.cpu_cores = _cpu_cores()
    report.memory_bytes = _memory_bytes()
    report.scratch_free_bytes = _free_bytes(scratch_dir or Path(tempfile.gettempdir()))

    for name in ALL_BACKENDS:
        backend = _backend_for_name(name)
        if backend.codec not in listed:
            report.encoders[name] = EncoderProbe(
                backend=name,
                available=False,
                reason=f"{backend.codec} not compiled into this FFmpeg",
                failure_kind="not-compiled",
            )
            continue
        if not probe:
            report.encoders[name] = EncoderProbe(backend=name, available=True, reason="not probed")
            continue
        report.encoders[name] = probe_backend(backend, ffmpeg=ffmpeg, run=run)

    return report


def _backend_for_name(name: str) -> EncoderBackend:
    from openvod_transcoder.encoding.backends import backend_named

    return backend_named(name)


def _cpu_cores() -> int:
    try:
        import os

        return os.cpu_count() or 0
    except Exception:  # noqa: BLE001
        return 0


def _memory_bytes() -> int:
    try:
        page = 4096
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
        return page
    except Exception:  # noqa: BLE001 — non-Linux hosts simply report 0
        return 0


def _free_bytes(path: Path) -> int:
    try:
        return shutil.disk_usage(str(path)).free
    except Exception:  # noqa: BLE001
        return 0


def probe_json(report: CapabilityReport) -> str:
    return json.dumps(report.to_payload(), sort_keys=True)


_FFMPEG_VERSION = re.compile(r"ffmpeg version\s+(\S+)", re.IGNORECASE)
_SHAKA_VERSION = re.compile(r"v?(\d+\.\d+\.\d+)")


def toolchain_versions(report: CapabilityReport) -> Dict[str, str]:
    """
    The toolchain identity recorded with every job.

    Version strings, not host paths: this travels into the completion payload and
    into reuse fingerprints, and it has to be comparable between two machines
    that never see each other.
    """
    from openvod_transcoder.config import ENGINE_VERSION, PROCESSING_PLAN_VERSION

    versions = {
        "engine": ENGINE_VERSION,
        "planVersion": str(PROCESSING_PLAN_VERSION),
        "ffmpeg": "",
        "shaka": "",
    }

    match = _FFMPEG_VERSION.search(report.ffmpeg or "")
    if match:
        versions["ffmpeg"] = match.group(1)
    elif report.ffmpeg:
        versions["ffmpeg"] = report.ffmpeg.strip()[:64]

    shaka = _SHAKA_VERSION.search(report.shaka or "")
    versions["shaka"] = shaka.group(1) if shaka else (report.shaka or "").strip()[:64]

    return versions


def toolchain_identity(report: CapabilityReport) -> str:
    """
    Compact, comparable identity of the toolchain that produced (or would
    produce) a job's bytes.

    Used as part of the reuse fingerprint: two machines with different FFmpeg
    builds do not produce byte-identical renditions, so cached work from the old
    build must not be reused after an upgrade.
    """
    versions = toolchain_versions(report)
    return ";".join(f"{key}={value}" for key, value in sorted(versions.items()))
