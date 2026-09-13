"""
openvod_transcoder — the shared OpenVOD processing engine.

One implementation of the video lifecycle's hard part (probe → plan → encode →
package → validate → inventory), used by both execution environments:

- the Modal GPU runner (:mod:`transcoding.main`), and
- the self-hosted agent (:mod:`openvod_transcoder.agent`).

Design rules this package holds to, in the order they constrain the code:

1. **Importing it costs nothing.** No Modal, no CUDA, no boto3, no Whisper, no
   R2 credentials. Optional dependencies are imported inside the feature that
   needs them, so `import openvod_transcoder` works on a bare machine and the
   engine can be imported by a test that touches none of it.
2. **The engine never authenticates to anything.** Transfers arrive as a
   parameter. This is what makes "the self-hosted agent holds no storage
   credentials" a property of the design rather than a promise in a document.
3. **Failures are typed.** :mod:`openvod_transcoder.errors` carries the stable
   codes the API stores, and separates the failures a different encoder could
   fix from the ones it could not.
4. **Hardware is proven, not assumed.** See
   :mod:`openvod_transcoder.encoding.probe`.
"""

__version__ = "1.0.0"

from openvod_transcoder.cancellation import CancellationToken, LeaseGuard
from openvod_transcoder.config import (
    DEFAULT_MAX_HEIGHT,
    ENCODING_PROFILES,
    PROCESSING_PLAN_VERSION,
    R2_PREFIX,
    SEGMENT_DURATION,
    EncodingProfile,
)
from openvod_transcoder.errors import (
    ERROR_CANCELLED,
    ERROR_EMPTY_FILE,
    ERROR_ENCODER_FAILED,
    ERROR_ENCODER_UNAVAILABLE,
    ERROR_INSUFFICIENT_DISK,
    ERROR_INVALID_CONTAINER,
    ERROR_INVALID_METADATA,
    ERROR_MISSING_RENDITION,
    ERROR_PACKAGING_FAILED,
    ERROR_PARTIAL_UPLOAD,
    ERROR_SOURCE_CHANGED,
    ERROR_SOURCE_MISSING,
    ERROR_STALLED,
    ERROR_TRANSCODE_FAILED,
    ERROR_UNSUPPORTED_HDR,
    CancelledError,
    TranscodeError,
    classify_error,
    is_fallback_eligible,
)
from openvod_transcoder.options import (
    PLAYBACK_PUBLIC,
    PLAYBACK_SIGNED,
    PROVIDER_MODAL,
    PROVIDER_SELF_HOSTED,
    ProcessingOptions,
)
from openvod_transcoder.planning import (
    POLICY_CAPPED,
    POLICY_LEGACY,
    fit_dimensions,
    plan_audio,
    plan_renditions,
)
from openvod_transcoder.progress import (
    STAGES,
    CallbackProgress,
    NullProgress,
    ProgressUpdate,
    overall_progress,
)
from openvod_transcoder.result import (
    Artifact,
    PipelineResult,
    ProcessingMetadata,
    RenditionReport,
    build_inventory,
    sha256_file,
)
from openvod_transcoder.snapshot import SourceSnapshot, create_snapshot

__all__ = [
    "Artifact",
    "CallbackProgress",
    "CancellationToken",
    "CancelledError",
    "DEFAULT_MAX_HEIGHT",
    "ENCODING_PROFILES",
    "ERROR_CANCELLED",
    "ERROR_EMPTY_FILE",
    "ERROR_ENCODER_FAILED",
    "ERROR_ENCODER_UNAVAILABLE",
    "ERROR_INSUFFICIENT_DISK",
    "ERROR_INVALID_CONTAINER",
    "ERROR_INVALID_METADATA",
    "ERROR_MISSING_RENDITION",
    "ERROR_PACKAGING_FAILED",
    "ERROR_PARTIAL_UPLOAD",
    "ERROR_SOURCE_CHANGED",
    "ERROR_SOURCE_MISSING",
    "ERROR_STALLED",
    "ERROR_TRANSCODE_FAILED",
    "ERROR_UNSUPPORTED_HDR",
    "EncodingProfile",
    "LeaseGuard",
    "NullProgress",
    "PLAYBACK_PUBLIC",
    "PLAYBACK_SIGNED",
    "POLICY_CAPPED",
    "POLICY_LEGACY",
    "PROCESSING_PLAN_VERSION",
    "PROVIDER_MODAL",
    "PROVIDER_SELF_HOSTED",
    "PipelineResult",
    "ProcessingMetadata",
    "ProcessingOptions",
    "ProgressUpdate",
    "R2_PREFIX",
    "RenditionReport",
    "SEGMENT_DURATION",
    "STAGES",
    "SourceSnapshot",
    "TranscodeError",
    "build_inventory",
    "classify_error",
    "create_snapshot",
    "fit_dimensions",
    "is_fallback_eligible",
    "overall_progress",
    "plan_audio",
    "plan_renditions",
    "sha256_file",
    "__version__",
]


def run_pipeline(*args, **kwargs):
    """
    Lazy re-export of :func:`openvod_transcoder.pipeline.run_pipeline`.

    Deferred on purpose: `pipeline` pulls in the packaging and video modules,
    and keeping it out of the import graph means `import openvod_transcoder`
    stays cheap for the agent's CLI when it only wants `--version` or `doctor`.
    """
    from openvod_transcoder.pipeline import run_pipeline as _run

    return _run(*args, **kwargs)
