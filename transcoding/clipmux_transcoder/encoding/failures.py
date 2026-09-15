"""
What an FFmpeg failure *means*, decided at the encoding boundary.

FFmpeg exits non-zero for reasons that demand opposite responses. A GPU whose
filter option this build does not implement must be retried without that filter;
a corrupt input must not be retried at all. Both arrive as "exit status 1" plus
some stderr, so the only place that distinction can be made is here — and it has
to be made before the exception reaches the fallback policy, because by then all
that is left is the type and the code.

The taxonomy is deliberately about *remedy*, not about FFmpeg's internal
vocabulary:

``session-exhausted``
    The device works but is busy (NVENC session limits, transient allocation
    failures). Serialize and retry the same backend; do not fall back.
``device``
    The accelerator cannot be opened at all: no device node, no driver, no
    render-group permission. This is *proof* the backend is unusable on this
    machine, so every other rendition skips it too.
``decode``
    Hardware decode of this source failed. Software decode plus hardware encode
    (the hybrid path) is the standard remedy.
``filter``
    The filter graph could not be built or configured — including the
    ``scale_cuda`` ``format`` rejection that motivated this module. Retry without
    the hardware filter.
``encoder``
    The encoder could not be opened or initialised. Like ``device``, this makes
    the backend unusable for the rest of the job.
``media`` / ``input`` / ``disk``
    The source, or the machine's ability to write it, is the problem. No encoder
    choice helps, and retrying wastes the owner's time.
``unknown``
    Unrecognised. Treated as *not* the encoder's fault: blaming the encoder for
    an unexplained failure buries the real error under a pointless re-encode.

Patterns are matched case-insensitively in a fixed priority order, and every
string below was observed in real FFmpeg output rather than invented. Ordering is
load-bearing: ``OpenEncodeSessionEx failed: out of memory`` is transient while
``OpenEncodeSessionEx failed: unsupported device`` is fatal, and the two share a
prefix.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

from clipmux_transcoder.errors import (
    ERROR_ENCODER_FAILED,
    ERROR_INSUFFICIENT_DISK,
    ERROR_SOURCE_MISSING,
    ERROR_TRANSCODE_FAILED,
    FFmpegProcessError,
)

# ── kinds ────────────────────────────────────────────────────────────────────

FAILURE_SESSION = "session-exhausted"
FAILURE_DEVICE = "device"
FAILURE_DECODE = "decode"
FAILURE_FILTER = "filter"
FAILURE_ENCODER = "encoder"
FAILURE_MEDIA = "media"
FAILURE_INPUT = "input"
FAILURE_DISK = "disk"
FAILURE_UNKNOWN = "unknown"

ALL_FAILURE_KINDS = (
    FAILURE_SESSION,
    FAILURE_DEVICE,
    FAILURE_DECODE,
    FAILURE_FILTER,
    FAILURE_ENCODER,
    FAILURE_MEDIA,
    FAILURE_INPUT,
    FAILURE_DISK,
    FAILURE_UNKNOWN,
)

# ── patterns, in priority order ──────────────────────────────────────────────

_SESSION_PATTERNS: Tuple[str, ...] = (
    "out of memory",
    "no free encoding session",
    "too many concurrent sessions",
    "insufficient resources",
    "resource temporarily unavailable",
    "session limit",
)

_DISK_PATTERNS: Tuple[str, ...] = (
    "no space left on device",
    "disk full",
    "disk quota exceeded",
)

# Device patterns are checked before the input patterns on purpose: a missing
# device node and a missing media file both surface as "No such file or
# directory", and only one of them is fixed by a different encoder.
_DEVICE_PATTERNS: Tuple[str, ...] = (
    "cannot open device",
    "/dev/dri",
    "/dev/nvidia",
    "no va display",
    "failed to initialise vaapi",
    "failed to initialize vaapi",
    "libva error",
    "device creation failed",
    "no device available",
    "cannot load libcuda",
    "cannot load nvcuda",
    "cannot load libnvcuvid",
    "cannot load libnvidia-encode",
    "libcuda.so",
    "cuda_error_no_device",
    "cuda_error_insufficient_driver",
    "no capable devices found",
    "device not found",
    "invalid device",
    "unknown device",
    "unsupported device",
    "no usable encoding profile",
    "failed to initialise nvenc",
    "failed to initialize nvenc",
    "function not implemented",
    "operation not permitted",
    "dri2",
)

_MEDIA_PATTERNS: Tuple[str, ...] = (
    "invalid data found when processing input",
    "moov atom not found",
    "header missing",
    "could not find codec parameters",
    "error opening input",
    "does not contain any stream",
    "end of file",
    "truncated",
    "corrupt",
    "error while decoding stream",
    "decoding for stream",
    "invalid nal",
    "missing picture in access unit",
)

_INPUT_PATTERNS: Tuple[str, ...] = (
    "no such file or directory",
    "permission denied",
    "input/output error",
    "is a directory",
)

_FILTER_PATTERNS: Tuple[str, ...] = (
    "error initializing filter",
    "error reinitializing filters",
    "error while filtering",
    "failed to inject frame into filter network",
    "no such filter",
    "filter not found",
    "option 'format' not found",
    "not found: 'format'",
    "impossible to convert between the formats",
    "unsupported pixel format",
    "invalid pixel format",
    "unsupported input format",
    "failed to configure the filter",
    "error configuring filters",
    # Naming the filter is itself evidence: `scale_cuda`/`scale_vaapi` only ever
    # appear in the hardware filter graph, and that graph is the part we can
    # retry without (software scale → hardware encode).
    "scale_cuda",
    "scale_vaapi",
    "hwupload",
    "zscale",
    "tonemap",
)

_DECODE_PATTERNS: Tuple[str, ...] = (
    "failed to setup hardware decoder",
    "hardware decoder",
    "no decoder surfaces left",
    "failed to decode",
    "decode_slice_header",
    "cuvid",
    "vaapi decode",
)

_ENCODER_PATTERNS: Tuple[str, ...] = (
    "unknown encoder",
    "encoder not found",
    "error while opening encoder",
    "could not open encoder",
    "error initializing output stream",
    "initializeencoder failed",
    "openencodesessionex failed",
    "encoder setup failed",
    "invalid encoder",
)

# Ordered rule table. The first matching group wins.
_RULES: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    (FAILURE_SESSION, _SESSION_PATTERNS),
    (FAILURE_DISK, _DISK_PATTERNS),
    (FAILURE_DEVICE, _DEVICE_PATTERNS),
    # These identify hardware decode specifically. FFmpeg appends the same
    # generic decoding-error footer for bad media and for a failed accelerator.
    (FAILURE_DECODE, ("hwaccel initialisation returned error", "failed to setup hardware decoder")),
    (FAILURE_MEDIA, _MEDIA_PATTERNS),
    (FAILURE_INPUT, _INPUT_PATTERNS),
    (FAILURE_FILTER, _FILTER_PATTERNS),
    (FAILURE_DECODE, _DECODE_PATTERNS),
    (FAILURE_ENCODER, _ENCODER_PATTERNS),
)

# Codes the fallback policy will act on. Anything else is terminal: the same
# machine re-running the same media would fail the same way.
_FALLBACK_ELIGIBLE_KINDS = frozenset({
    FAILURE_SESSION,
    FAILURE_DEVICE,
    FAILURE_DECODE,
    FAILURE_FILTER,
    FAILURE_ENCODER,
})

# Kinds that prove the *backend* is unusable here, so other renditions skip every
# candidate using it. A filter failure proves nothing of the sort — it is this
# source hitting one option — which is exactly why the hybrid path must survive
# it.
_BACKEND_UNUSABLE_KINDS = frozenset({FAILURE_DEVICE, FAILURE_ENCODER})

_CODE_FOR_KIND = {
    FAILURE_SESSION: ERROR_ENCODER_FAILED,
    FAILURE_DEVICE: ERROR_ENCODER_FAILED,
    FAILURE_DECODE: ERROR_ENCODER_FAILED,
    FAILURE_FILTER: ERROR_ENCODER_FAILED,
    FAILURE_ENCODER: ERROR_ENCODER_FAILED,
    FAILURE_MEDIA: ERROR_TRANSCODE_FAILED,
    FAILURE_INPUT: ERROR_SOURCE_MISSING,
    FAILURE_DISK: ERROR_INSUFFICIENT_DISK,
    FAILURE_UNKNOWN: ERROR_TRANSCODE_FAILED,
}

# Probe verdicts (see encoding.probe) stay a separate, smaller vocabulary: the
# probe only needs "is this accelerator usable for this source".
_PROBE_VERDICT_FOR_KIND = {
    FAILURE_SESSION: "session-exhausted",
    FAILURE_DEVICE: "device-unavailable",
    FAILURE_FILTER: "unsupported-format",
    FAILURE_DECODE: "unsupported-format",
}

MAX_STDERR_LINES = 50


def classify_ffmpeg_stderr(stderr: str, *, backend: Optional[str] = None) -> str:
    """
    Map FFmpeg stderr onto one :data:`ALL_FAILURE_KINDS` value.

    ``backend`` is accepted for context and logging; it deliberately does not
    change the verdict. A given message means the same thing whichever encoder
    produced it, and letting the backend bias the classification would make the
    fallback policy depend on the very thing it is trying to evaluate.
    """
    text = (stderr or "").lower()
    if not text.strip():
        return FAILURE_UNKNOWN
    for kind, patterns in _RULES:
        for pattern in patterns:
            if pattern in text:
                return kind
    return FAILURE_UNKNOWN


def is_fallback_eligible_kind(kind: str) -> bool:
    """True when trying a different encoder path could plausibly succeed."""
    return kind in _FALLBACK_ELIGIBLE_KINDS


def marks_backend_unusable(kind: str) -> bool:
    """True when this failure proves the backend cannot work on this machine."""
    return kind in _BACKEND_UNUSABLE_KINDS


def error_code_for_failure_kind(kind: str) -> str:
    """The stable wire code for a failure kind (existing codes only)."""
    return _CODE_FOR_KIND.get(kind, ERROR_TRANSCODE_FAILED)


def probe_verdict_for_kind(kind: str) -> str:
    """The probe vocabulary's verdict for a failure kind."""
    return _PROBE_VERDICT_FOR_KIND.get(kind, "encode-failed")


def bounded_stderr(stderr: str, *, limit: int = MAX_STDERR_LINES) -> str:
    """The last ``limit`` lines of stderr — enough to diagnose, small enough to report."""
    lines: List[str] = (stderr or "").strip().splitlines()
    return "\n".join(lines[-limit:])


def build_process_error(
    *,
    stderr: str,
    returncode: int,
    operation: str,
    message: str = "",
    backend: Optional[str] = None,
) -> FFmpegProcessError:
    """
    Build the structured exception for one failed FFmpeg process.

    The kind (and therefore the error code, and therefore whether the fallback
    policy may act) is decided here, once, from the process's own output.
    """
    kind = classify_ffmpeg_stderr(stderr, backend=backend)
    detail = bounded_stderr(stderr)
    summary = message or f"{operation} failed (exit={returncode})"
    if detail:
        summary = f"{summary}\nSTDERR:\n{detail}"
    return FFmpegProcessError(
        summary,
        returncode=returncode,
        stderr=detail,
        operation=operation,
        failure_kind=kind,
        code=error_code_for_failure_kind(kind),
    )
