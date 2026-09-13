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

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

from openvod_transcoder.encoding.backends import (
    ALL_BACKENDS,
    BACKEND_CPU,
    BACKEND_NVENC,
    BACKEND_VAAPI,
    CPU_BACKEND,
    EncoderBackend,
    backend_named,
)
from openvod_transcoder.encoding.probe import CapabilityReport
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


@dataclass
class FallbackState:
    """
    Tracks the chain and decides what to try after a failure.

    Kept as an object rather than a loop-local so the *reason* each fallback
    happened survives into the job report: "encoded on CPU because VAAPI could
    not open the render device" is a support answer, and one the operator can
    act on.
    """
    chain: Sequence[BackendCandidate]
    index: int = 0
    fallback_reasons: List[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.fallback_reasons is None:
            self.fallback_reasons = []

    @property
    def current(self) -> BackendCandidate:
        return self.chain[self.index]

    @property
    def exhausted(self) -> bool:
        return self.index >= len(self.chain) - 1

    def advance(self, exc: BaseException) -> Optional[BackendCandidate]:
        """
        Move to the next candidate after ``exc``, or return ``None``.

        ``None`` means "do not retry": either the failure is not encoder-related
        (bad media, missing file, full disk, refused upload) or the chain is
        exhausted.
        """
        if not is_fallback_eligible(exc):
            return None
        if self.exhausted:
            return None
        previous = self.current
        self.index += 1
        self.fallback_reasons.append(
            f"{previous.label} -> {self.current.label}: {type(exc).__name__}: {exc}"
        )
        return self.current


def describe_chain(chain: Sequence[BackendCandidate]) -> str:
    return " -> ".join(candidate.label for candidate in chain)
