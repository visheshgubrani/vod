"""
Typed error taxonomy for the transcoding pipeline.

Workers report these codes (plus a human message) to the API callback so the
server can store machine-readable failure reasons (video.failure_code) instead
of raw Python exception names.

Two families, and the distinction is load-bearing:

- **Encoder-path failures** (``ENCODER_*``) are the *only* ones eligible for a
  fallback retry. A GPU session running out is not evidence that the media is
  bad, and retrying on the CPU is the right answer.
- **Media and environment failures** (``INVALID_*``, ``EMPTY_FILE``,
  ``SOURCE_*``, ``INSUFFICIENT_DISK``, ``PARTIAL_UPLOAD``, ``PACKAGING_FAILED``)
  must never trigger a fallback: re-running an undecodable file on a different
  encoder wastes the owner's time and produces the same failure, a full disk
  gets no fuller, and a packager that rejected the package has already been told
  what the encoder produced.

``FFmpegProcessError`` is how a non-zero FFmpeg exit enters this taxonomy. It is
built by :func:`clipmux_transcoder.encoding.failures.build_process_error`, which
classifies the process's stderr into the kind that decides both the code and
whether the fallback policy may act on it.
"""

# ── error codes (stable contract with the API) ──────────────────────────────
ERROR_INVALID_CONTAINER = "INVALID_CONTAINER"      # no audio/video streams found
ERROR_EMPTY_FILE = "EMPTY_FILE"                    # zero-byte / truncated / no duration
ERROR_INVALID_METADATA = "INVALID_METADATA"        # video stream present but unusable dims/fps
ERROR_AUDIO_ONLY_UNSUPPORTED = "AUDIO_ONLY_UNSUPPORTED"  # audio-only passthrough not built yet
ERROR_INSUFFICIENT_DISK = "INSUFFICIENT_DISK"      # scratch too small for this source
ERROR_PARTIAL_UPLOAD = "PARTIAL_UPLOAD"            # uploaded files != expected outputs
ERROR_TRANSCODE_FAILED = "TRANSCODE_FAILED"        # generic pipeline failure

# Source handling (self-hosted agents)
ERROR_SOURCE_MISSING = "SOURCE_MISSING"            # file moved, unmounted or deleted
ERROR_SOURCE_CHANGED = "SOURCE_CHANGED"            # identity/size changed since registration
ERROR_SOURCE_UNREADABLE = "SOURCE_UNREADABLE"      # permissions, special file, symlink escape

# Encoder selection — the fallback-eligible family
ERROR_ENCODER_UNAVAILABLE = "ENCODER_UNAVAILABLE"  # selected backend not usable on this host
ERROR_ENCODER_FAILED = "ENCODER_FAILED"            # backend started but the encode failed
ERROR_UNSUPPORTED_HDR = "UNSUPPORTED_HDR"          # HDR variant with no validated conversion path

# Packaging / validation
ERROR_PACKAGING_FAILED = "PACKAGING_FAILED"        # Shaka failed or produced an invalid package
ERROR_MISSING_RENDITION = "MISSING_RENDITION"      # a required rendition is absent from the package

# Cancellation is not a failure; the API maps it to `cancelled`, not `failed`.
ERROR_CANCELLED = "CANCELLED"                      # owner or server cancelled the job
ERROR_STALLED = "STALLED"                          # no encoder progress within the stall window


class TranscodeError(Exception):
    """Pipeline error carrying a stable machine-readable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class FFmpegProcessError(TranscodeError):
    """
    A subprocess exited non-zero, described well enough to act on.

    Before this existed, FFmpeg failures surfaced as a bare ``RuntimeError``.
    ``is_fallback_eligible`` only recognises :class:`TranscodeError`, so the
    fallback chain was skipped for *every* FFmpeg failure — including the
    ``scale_cuda`` filter rejection that a hybrid retry fixes immediately. The
    exit status, a bounded stderr tail and the operation that failed are carried
    so the callback payload, the logs and the retry decision all describe the
    same event.

    ``stderr`` is truncated (see ``failures.bounded_stderr``): a raw FFmpeg
    stderr can run to thousands of lines, and it travels into the completion
    payload.
    """

    def __init__(
        self,
        message: str,
        *,
        returncode: int,
        stderr: str = "",
        operation: str = "",
        failure_kind: str = "unknown",
        code: str = ERROR_TRANSCODE_FAILED,
    ) -> None:
        super().__init__(code, message)
        self.returncode = returncode
        self.stderr = stderr
        self.operation = operation
        self.failure_kind = failure_kind


class CancelledError(TranscodeError):
    """Raised when cancellation is observed. Never reported as a failure."""

    def __init__(self, message: str = "Job cancelled"):
        super().__init__(ERROR_CANCELLED, message)


# Codes where retrying on a different encoder backend is a sensible response.
# Everything else is deterministic given the same media and same machine.
#
# PACKAGING_FAILED is deliberately *not* here. Shaka runs after every rendition
# is already encoded, so a packaging failure has no encoder left to fall back
# from; retrying it through the chain re-encodes nothing and reports the wrong
# cause. Packaging errors carry their own code for exactly that reason.
FALLBACK_ELIGIBLE_CODES = frozenset({
    ERROR_ENCODER_UNAVAILABLE,
    ERROR_ENCODER_FAILED,
})


def is_fallback_eligible(exc: BaseException) -> bool:
    """True when a different encoder backend could plausibly succeed."""
    return isinstance(exc, TranscodeError) and exc.code in FALLBACK_ELIGIBLE_CODES


def classify_error(exc: BaseException) -> str:
    """Map an exception to a stable error code for the callback payload."""
    if isinstance(exc, TranscodeError):
        return exc.code
    return ERROR_TRANSCODE_FAILED
