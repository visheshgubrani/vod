"""
Typed error taxonomy for the transcoding pipeline.

Workers report these codes (plus a human message) to the API callback so the
server can store machine-readable failure reasons (video.failure_code) instead
of raw Python exception names.
"""

# ── error codes (stable contract with the API) ──────────────────────────────
ERROR_INVALID_CONTAINER = "INVALID_CONTAINER"      # no audio/video streams found
ERROR_EMPTY_FILE = "EMPTY_FILE"                    # zero-byte / truncated / no duration
ERROR_INVALID_METADATA = "INVALID_METADATA"        # video stream present but unusable dims/fps
ERROR_AUDIO_ONLY_UNSUPPORTED = "AUDIO_ONLY_UNSUPPORTED"  # audio-only passthrough not built yet
ERROR_INSUFFICIENT_DISK = "INSUFFICIENT_DISK"      # /tmp too small for this source
ERROR_PARTIAL_UPLOAD = "PARTIAL_UPLOAD"            # uploaded files != expected outputs
ERROR_TRANSCODE_FAILED = "TRANSCODE_FAILED"        # generic pipeline failure


class TranscodeError(Exception):
    """Pipeline error carrying a stable machine-readable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def classify_error(exc: BaseException) -> str:
    """Map an exception to a stable error code for the callback payload."""
    if isinstance(exc, TranscodeError):
        return exc.code
    return ERROR_TRANSCODE_FAILED
