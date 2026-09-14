"""
Encoder selection and the fallback policy.

The policy is small but every rule in it was chosen against a specific failure
mode, so it lives in one place as pure functions rather than as conditionals
scattered through the pipeline:

- **Automatic selection may fall back; explicit selection may not.** An operator
  who chose NVENC because CPU encoding saturates their machine must be told the
  GPU is unusable, not silently given the CPU encode they were avoiding. The
  error has to be actionable, so it names the backend, the device and the
  remedy.
- **Fallback is limited to encoder-path failures.** Re-running an undecodable
  file, a missing source, a full disk or a rejected upload on a different
  encoder changes nothing and burns the owner's time — those raise immediately.
- **Hardware to software decode comes first.** Dropping only the hardware
  *decode/filter* keeps the expensive part (the encode) on the GPU, and is the
  right answer for a source whose pixel format the decoder rejects. Only if the
  hardware encoder itself fails does the chain reach the CPU.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Sequence

from openvod_transcoder.cancellation import CancellationToken

from openvod_transcoder.encoding.backends import (
    ALL_BACKENDS,
    BACKEND_CPU,
    BACKEND_NVENC,
    BACKEND_VAAPI,
    CPU_BACKEND,
    EncoderBackend,
    backend_named,
)
from openvod_transcoder.encoding.probe import CapabilityReport, ChainProbe
from openvod_transcoder.errors import (
    ERROR_ENCODER_UNAVAILABLE,
    TranscodeError,
    is_fallback_eligible,
)

# Preference order for `auto`. NVENC first because it is the most widely
# deployed in the Modal fleet and on consumer cards; VAAPI second because it is
# the supported Linux path for AMD and Intel; CPU last because it always works.
AUTO_PREFERENCE: Sequence[str] = (BACKEND_NVENC, BACKEND_VAAPI, BACKEND_CPU)


@dataclass(frozen=True)
class BackendCandidate:
    """
    One entry in a fallback chain, with the decode mode to try for it.

    ``gpu_decode=False`` on a hardware backend is the *hybrid* path: software
    decode and filter, hardware encode.
    """
    backend: EncoderBackend
    gpu_decode: bool

    @property
    def label(self) -> str:
        suffix = "" if self.gpu_decode or not self.backend.is_hardware else "+software-decode"
        return f"{self.backend.name}{suffix}"

    @property
    def mode(self) -> str:
        """The execution path this candidate represents, for the job's metadata."""
        if not self.backend.is_hardware:
            return "cpu"
        return "gpu" if self.gpu_decode else "hybrid"


def select_chain(
    requested: str,
    report: CapabilityReport,
    *,
    device: Optional[str] = None,
) -> List[BackendCandidate]:
    """
    Build the ordered list of attempts for a job.

    ``requested`` is one of ``auto``, ``cpu``, ``nvenc``, ``vaapi`` (optionally
    ``nvenc:1`` / ``vaapi:/dev/dri/renderD129`` for multi-GPU machines).
    """
    normalized = (requested or "auto").strip().lower()

    if normalized == "cpu" or normalized.startswith("cpu:"):
        return [BackendCandidate(CPU_BACKEND, gpu_decode=False)]

    if normalized in ("auto", ""):
        chain: List[BackendCandidate] = []
        for name in AUTO_PREFERENCE:
            backend = _available(name, report, device)
            if backend is None:
                continue
            chain.append(
                BackendCandidate(backend, gpu_decode=backend.is_hardware)
            )
            if backend.is_hardware:
                # Hybrid first-fallback for the same encoder.
                chain.append(BackendCandidate(backend, gpu_decode=False))
        if not chain:
            # Every probe failed, including CPU's. Attempt the CPU anyway: the
            # probe itself can fail for environmental reasons (no scratch space),
            # and a real attempt produces a far better error message.
            chain.append(BackendCandidate(CPU_BACKEND, gpu_decode=False))
        return _dedupe(chain)

    backend = backend_named(f"{normalized}:{device}" if device and ":" not in normalized else normalized)
    if backend.name in (BACKEND_NVENC, BACKEND_VAAPI):
        probe = report.encoders.get(backend.name)
        if probe is not None and not probe.available:
            raise TranscodeError(
                ERROR_ENCODER_UNAVAILABLE,
                _unavailable_message(backend, probe.reason, probe.detail),
            )
        return [
            BackendCandidate(backend, gpu_decode=True),
            BackendCandidate(backend, gpu_decode=False),
        ]
    return [BackendCandidate(backend, gpu_decode=False)]


def _available(
    name: str,
    report: CapabilityReport,
    device: Optional[str],
) -> Optional[EncoderBackend]:
    probe = report.encoders.get(name)
    if probe is None or not probe.available:
        return None
    if name == BACKEND_CPU:
        return backend_named(BACKEND_CPU)
    if device:
        return backend_named(f"{name}:{device}")
    return backend_named(name)


def _dedupe(chain: Sequence[BackendCandidate]) -> List[BackendCandidate]:
    seen = set()
    result = []
    for candidate in chain:
        key = (candidate.backend.name, candidate.backend.device, candidate.gpu_decode)
        if key in seen:
            continue
        seen.add(key)
        result.append(candidate)
    return result


def _unavailable_message(backend: EncoderBackend, reason: str, detail: str) -> str:
    remedy = {
        BACKEND_NVENC: (
            "check that the NVIDIA driver is loaded on the host, that the "
            "NVIDIA Container Toolkit is installed, and that the container was "
            "started with the `video` driver capability (in addition to compute "
            "and utility)"
        ),
        BACKEND_VAAPI: (
            f"check that {backend.device} exists, that the agent's user is in "
            "the `render` group, and that Mesa's VAAPI driver is installed"
        ),
    }.get(backend.name, "check the agent's hardware configuration")

    message = (
        f"encoder backend '{backend.name}' was selected explicitly but is not "
        f"usable on this machine ({reason}). To use it, {remedy}. "
        f"Select 'cpu' to encode in software instead."
    )
    if detail:
        message += f"\nProbe output:\n{detail}"
    return message


def build_attempt_chain(
    chain: Sequence[BackendCandidate],
    *,
    gpu_path_supported: bool,
    probes: Mapping[str, ChainProbe],
    require_verification: bool,
) -> List[BackendCandidate]:
    """
    Narrow a capability chain to the paths that were *verified for this source*.

    Three inputs, and each removes something different:

    - the source's own properties (``gpu_path_supported``: codec, pixel format,
      bit depth, rotation, HDR) remove the GPU *filter* path for sources it has
      not been validated against — those still get the hybrid path, which is the
      slow-but-correct answer;
    - the preflight result removes the whole backend when its encoder could not
      encode this source at all;
    - ``require_verification`` expresses the difference between ``auto`` and an
      explicit choice. Under ``auto`` an unverified GPU is *excluded* (a job must
      not die half way down the ladder because the accelerator was assumed to
      work); under an explicit ``nvenc``/``vaapi`` the candidates survive so the
      operator gets the real error instead of a silent CPU encode.

    The result is never empty: with nothing left, the CPU is attempted, because
    a real attempt produces a far better error message than "nothing is
    available".
    """
    narrowed: List[BackendCandidate] = []

    for candidate in chain:
        if not candidate.backend.is_hardware:
            narrowed.append(candidate)
            continue

        probe = probes.get(candidate.backend.name)
        verified = probe is not None and probe.hardware_encode

        if require_verification and not verified:
            continue

        if candidate.gpu_decode:
            if not gpu_path_supported:
                continue
            # Under `auto` the full-GPU path needs positive verification for
            # this source. An explicit backend keeps its candidates so the
            # operator sees the real failure instead of a silent CPU encode.
            if require_verification and not (
                verified and probe.hardware_decode and probe.hardware_filters
            ):
                continue

        narrowed.append(candidate)

    if not narrowed:
        narrowed.append(BackendCandidate(CPU_BACKEND, gpu_decode=False))
    return _dedupe(narrowed)


@dataclass
class WorkerEncoderState:
    """
    What one worker has *proven* about the machine while encoding.

    Shared by every rendition in the job, unlike the per-rendition attempt
    state. A backend that could not open its device is not going to open it for
    the next rung either, so the proof is recorded once and every other rendition
    skips that backend's candidates instead of re-discovering the same failure
    three times.

    GPU admission switches to serial execution after session exhaustion. The
    retry waits for ordinary encodes too, and every wait observes cancellation.
    """

    unusable: Dict[str, str] = None  # type: ignore[assignment]
    cpu_limit: int = 0
    cpu_slots: Optional[threading.BoundedSemaphore] = None
    gpu_condition: threading.Condition = None  # type: ignore[assignment]
    active_gpu: int = 0
    serialize_gpu: bool = False

    def __post_init__(self) -> None:
        if self.unusable is None:
            self.unusable = {}
        if self.cpu_limit > 0:
            self.cpu_slots = threading.BoundedSemaphore(self.cpu_limit)
        self.gpu_condition = threading.Condition()

    @contextmanager
    def gpu_slot(self, token: CancellationToken, *, serialize: bool = False):
        """After exhaustion, drain existing GPU work and serialize new attempts."""
        with self.gpu_condition:
            if serialize:
                self.serialize_gpu = True
            while self.serialize_gpu and self.active_gpu:
                token.raise_if_cancelled()
                self.gpu_condition.wait(timeout=0.1)
            token.raise_if_cancelled()
            self.active_gpu += 1
        try:
            yield
        finally:
            with self.gpu_condition:
                self.active_gpu -= 1
                self.gpu_condition.notify_all()

    @contextmanager
    def cpu_slot(self, token: CancellationToken):
        """Bound CPU work even when it is reached by a GPU worker's fallback."""
        if self.cpu_slots is None:
            yield
            return
        while not self.cpu_slots.acquire(timeout=0.1):
            token.raise_if_cancelled()
        try:
            token.raise_if_cancelled()
            yield
        finally:
            self.cpu_slots.release()

    def mark_unusable(self, backend_name: str, reason: str) -> None:
        self.unusable.setdefault(backend_name, reason)

    def is_unusable(self, backend_name: str) -> bool:
        return backend_name in self.unusable

    def reason(self, backend_name: str) -> str:
        return self.unusable.get(backend_name, "")

    def as_reasons(self) -> List[str]:
        return [f"{name}: {reason}" for name, reason in sorted(self.unusable.items())]


@dataclass
class FallbackState:
    """
    Tracks one rendition's chain and decides what to try after a failure.

    Kept as an object rather than a loop-local so the *reason* each fallback
    happened survives into the job report: "encoded on CPU because VAAPI could
    not open the render device" is a support answer, and one the operator can
    act on.

    One instance per rendition, deliberately. A shared instance meant the first
    rendition to hit a GPU limit advanced *every* rendition's chain, so a ladder
    could report renditions produced by backends that were never tried.
    """
    chain: Sequence[BackendCandidate]
    index: int = 0
    fallback_reasons: List[str] = None  # type: ignore[assignment]
    attempt_counts: Dict[str, int] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.fallback_reasons is None:
            self.fallback_reasons = []
        if self.attempt_counts is None:
            self.attempt_counts = {}

    @property
    def current(self) -> BackendCandidate:
        return self.chain[self.index]

    @property
    def exhausted(self) -> bool:
        return self.index >= len(self.chain) - 1

    def attempts_for(self, label: str) -> int:
        return self.attempt_counts.get(label, 0)

    def record_attempt(self) -> BackendCandidate:
        """Note that the current candidate is being tried (once more)."""
        candidate = self.current
        self.attempt_counts[candidate.label] = self.attempts_for(candidate.label) + 1
        return candidate

    def advance(self, exc: BaseException) -> Optional[BackendCandidate]:
        """
        Move to the next candidate after ``exc``, or return ``None``.

        ``None`` means "do not retry": either the failure is not encoder-related
        (bad media, missing file, full disk, refused upload, a packager that
        rejected the package) or the chain is exhausted.
        """
        if not is_fallback_eligible(exc):
            return None
        return self._step(f"{type(exc).__name__}: {exc}")

    def skip(self, reason: str) -> Optional[BackendCandidate]:
        """
        Move past a candidate that was never attempted.

        Used when another rendition already proved this backend unusable: the
        skip is not a failure of *this* encode, and recording it as one would
        misreport why the rendition ended up on the CPU.
        """
        return self._step(f"skipped: {reason}")

    def _step(self, reason: str) -> Optional[BackendCandidate]:
        if self.exhausted:
            return None
        previous = self.current
        self.index += 1
        self.fallback_reasons.append(f"{previous.label} -> {self.current.label}: {reason}")
        return self.current


def describe_chain(chain: Sequence[BackendCandidate]) -> str:
    return " -> ".join(candidate.label for candidate in chain)
