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
    h264_level,
    input_args,
)

# Failure signatures that mean "this accelerator is not usable here", as opposed
# to "the media is bad". Matched case-insensitively against FFmpeg's stderr.
#
# The distinction drives the fallback decision: a missing device must fall back,
# a corrupt frame must not.
DEVICE_UNAVAILABLE_PATTERNS: Sequence[str] = (
    "cannot open device",
    "no va display",
    "device creation failed",
    "failed to set value",
    "no such file or directory",
    "no device available",
    "failed to initialise vaapi",
    "failed to initialise nvenc",
    "cannot load libcuda",
    "cannot load nvcuda",
    "cuda_error_no_device",
    "no capable devices found",
    "device not found",
    "permission denied",
    "operation not permitted",
    "invalid device",
    "unknown device",
    "function not implemented",
    "no usable encoding profile",
    "unsupported device",
)

# Session exhaustion is transient, not permanent: the right response is to wait
# and retry the same backend, not to re-encode the whole job on the CPU.
SESSION_EXHAUSTED_PATTERNS: Sequence[str] = (
    "out of memory",
    "no free encoding session",
    "too many concurrent sessions",
    "insufficient resources",
    "resource temporarily unavailable",
)

# A source whose pixel format the hardware path cannot ingest.
UNSUPPORTED_FORMAT_PATTERNS: Sequence[str] = (
    "unsupported pixel format",
    "impossible to convert between the formats",
    "pixel format",
    "invalid pixel format",
    "unsupported input format",
)


def classify_probe_failure(stderr: str) -> str:
    """
    Map FFmpeg stderr onto a probe verdict.

    Pure, and checked against literals: the strings below are copied from real
    FFmpeg output rather than invented, because the whole point of the module is
    to stop guessing about hardware.
    """
    text = (stderr or "").lower()
    for pattern in SESSION_EXHAUSTED_PATTERNS:
        if pattern in text:
            return "session-exhausted"
    for pattern in DEVICE_UNAVAILABLE_PATTERNS:
        if pattern in text:
            return "device-unavailable"
    for pattern in UNSUPPORTED_FORMAT_PATTERNS:
        if pattern in text:
            return "unsupported-format"
    return "encode-failed"


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
    device. The pipeline uses them to decide between a full hardware path and a
    hybrid (software decode → hardware encode) rather than assuming either.
    """
    backend: str
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


def preflight_source(
    source_path: Path,
    metadata: SourceTraits,
    backend: EncoderBackend,
    *,
    ffmpeg: str = "ffmpeg",
    run: Callable[..., subprocess.CompletedProcess] | None = None,
    duration: float = 1.5,
    timeout: float = PROBE_TIMEOUT_SECONDS,
) -> ChainProbe:
    """
    Encode the first ``duration`` seconds of the real source on this backend.

    This is where "the encoder works" becomes "the encoder works *for this
    file*": pixel format, bit depth, chroma location and resolution limits are
    all properties of the source, and a synthetic probe cannot see any of them.

    Decode and filter are reported separately so the caller can keep hardware
    *encoding* while falling back to software decode — the common and useful
    outcome on a machine whose decoder rejects the source's profile.
    """
    executor = run or subprocess.run
    spec = RenderSpec(
        label="preflight",
        width=max(2, _even(min(320, metadata.width or 320))),
        height=max(2, _even(min(240, metadata.height or 240))),
        bitrate="500k",
        maxrate="600k",
        bufsize="1M",
        fps=min(metadata.fps or 25.0, 30.0),
    )

    attempts = [
        # Full hardware path: decode and filter on the device.
        ("hardware", input_args(backend, metadata, gpu_decode=True), _hardware_filters(backend, spec)),
        # Hybrid: software decode and filter, hardware encode only.
        ("hybrid", [], _software_filters(spec)),
    ]

    last: ChainProbe = ChainProbe(backend=backend.name, reason="preflight did not run")
    for mode, decode_args, filters in attempts:
        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "error",
            *decode_args,
            "-t", f"{duration:.2f}",
            "-i", str(source_path),
        ]
        if filters:
            cmd += ["-vf", filters]
        cmd += [
            "-c:v", backend.codec,
            *_preflight_encoder_args(backend, spec),
            "-frames:v", "1",
            "-f", "null", "-",
        ]
        try:
            completed = executor(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            last = ChainProbe(backend=backend.name, reason="preflight timed out")
            continue
        except FileNotFoundError:
            return ChainProbe(backend=backend.name, reason=f"{ffmpeg} not found")

        if completed.returncode == 0:
            return ChainProbe(
                backend=backend.name,
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


def _preflight_encoder_args(backend: EncoderBackend, spec: RenderSpec) -> List[str]:
    return [
        "-b:v", spec.bitrate,
        "-maxrate:v", spec.maxrate,
        "-bufsize:v", spec.bufsize,
        "-profile:v", "high",
        "-level:v", h264_level(spec.height, spec.fps),
    ]


def _hardware_filters(backend: EncoderBackend, spec: RenderSpec) -> str:
    if backend.name == BACKEND_NVENC:
        return "scale_cuda=320:240:format=yuv420p"
    return "format=nv12,hwupload,scale_vaapi=w=320:h=240:format=nv12"


def _software_filters(spec: RenderSpec) -> str:
    return f"scale={spec.width}:{spec.height},setsar=1"


def _even(value: int) -> int:
    return value - (value % 2)


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
