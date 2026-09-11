"""
Progress reporting: one vocabulary shared by the Modal runner, the agent and the
dashboard.

The stage names and the 0..1 scale are a wire contract — the API stores them on
``processing.stage`` and the dashboard renders them. Percentages are deliberately
*not* derived from elapsed time: a CPU encode of a 90-minute lecture takes hours,
and a fabricated ETA that keeps counting down is worse than no ETA.

Per-rendition progress is reported as its own map so the dashboard can show real
FFmpeg progress ("1080p 42%") instead of a single opaque bar, and so stall
detection has a signal that is independent of the liveness heartbeat: a worker
whose heartbeat thread is fine but whose encoder is wedged must still be caught.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Mapping, Optional, Protocol

# Wire-contract stage names. Ordered, and the order is the computation order.
STAGE_SNAPSHOT = "snapshot"
STAGE_DOWNLOAD = "download"
STAGE_ANALYZE = "analyze"
STAGE_TRANSCODE = "transcode"
STAGE_PACKAGE = "package"
STAGE_VERIFY = "verify"
STAGE_UPLOAD = "upload"
STAGE_COMPLETE = "complete"

STAGES = (
    STAGE_SNAPSHOT,
    STAGE_DOWNLOAD,
    STAGE_ANALYZE,
    STAGE_TRANSCODE,
    STAGE_PACKAGE,
    STAGE_VERIFY,
    STAGE_UPLOAD,
    STAGE_COMPLETE,
)

# How much of the overall 0..1 budget each stage owns. Encoding dominates by
# design: it is the only stage whose duration scales with content length, so
# anchoring most of the bar there is what makes the bar move at a believable
# rate for a long job.
STAGE_WEIGHTS: Dict[str, float] = {
    STAGE_SNAPSHOT: 0.02,
    STAGE_DOWNLOAD: 0.08,
    STAGE_ANALYZE: 0.02,
    STAGE_TRANSCODE: 0.60,
    STAGE_PACKAGE: 0.10,
    STAGE_VERIFY: 0.03,
    STAGE_UPLOAD: 0.15,
    STAGE_COMPLETE: 0.00,
}


def overall_progress(stage: str, fraction: float) -> float:
    """
    Convert an in-stage fraction into the overall 0..1 progress the API stores.

    Pure, and the only place the weighting lives, so the runner and the agent
    cannot disagree about what "60%" means.
    """
    if stage not in STAGE_WEIGHTS:
        raise ValueError(f"unknown stage: {stage!r}")
    completed = 0.0
    for name in STAGES:
        if name == stage:
            break
        completed += STAGE_WEIGHTS[name]
    span = STAGE_WEIGHTS[stage]
    clamped = min(1.0, max(0.0, float(fraction)))
    return round(min(1.0, completed + span * clamped), 4)


@dataclass
class ProgressUpdate:
    """One progress report."""
    stage: str
    fraction: float = 0.0
    detail: str = ""
    # Per-rendition completion (0..1), keyed by rendition label.
    renditions: Dict[str, float] = field(default_factory=dict)
    # Encoder throughput as a multiple of realtime, when known.
    speed: Optional[float] = None

    @property
    def overall(self) -> float:
        return overall_progress(self.stage, self.fraction)

    def as_payload(self) -> dict:
        payload: Dict[str, object] = {
            "stage": self.stage,
            "progress": self.overall,
        }
        if self.detail:
            payload["detail"] = self.detail
        if self.renditions:
            payload["renditions"] = {
                label: round(value, 4) for label, value in sorted(self.renditions.items())
            }
        if self.speed is not None:
            payload["speed"] = round(float(self.speed), 3)
        return payload


class ProgressSink(Protocol):
    def report(self, update: ProgressUpdate) -> None: ...


class NullProgress:
    """Discards updates. Used by tests and by `--quiet` CLI runs."""

    def report(self, update: ProgressUpdate) -> None:  # noqa: ARG002 — protocol shape
        return None


class CallbackProgress:
    """Adapts a plain callable to the sink protocol."""

    def __init__(self, callback: Callable[[ProgressUpdate], None]) -> None:
        self._callback = callback

    def report(self, update: ProgressUpdate) -> None:
        self._callback(update)


class RenditionProgress:
    """
    Tracks per-rendition completion and reports the aggregate.

    Also the stall detector's input: :meth:`note_activity` records the last time
    *any* rendition made forward progress, which is what distinguishes "slow but
    alive" from "wedged". Encoder ``speed`` is intentionally not part of that
    test — a machine under load reports a low speed while making progress, and
    killing it would be wrong.
    """

    def __init__(self, sink: ProgressSink, labels: Mapping[str, float]) -> None:
        self._sink = sink
        # label -> share of the transcode stage this rendition is worth. Long
        # renditions take longer, so equal shares would misreport progress.
        self._shares: Dict[str, float] = dict(labels)
        self._fractions: Dict[str, float] = {label: 0.0 for label in self._shares}
        self._lock = threading.Lock()
        self._last_activity: float = time.monotonic()
        self._speed: Optional[float] = None

    @property
    def last_activity(self) -> float:
        with self._lock:
            return self._last_activity

    def label_for(self, key: str) -> str:
        return "audio" if key == "audio" else key

    def update(self, label: str, fraction: float, speed: Optional[float] = None) -> None:
        if label not in self._fractions:
            # A rendition we did not plan for (a fallback path) still counts as
            # activity, otherwise it would look like a stall.
            self._fractions[label] = 0.0
            self._shares[label] = 0.0
        with self._lock:
            previous = self._fractions[label]
            self._fractions[label] = min(1.0, max(0.0, float(fraction)))
            if self._fractions[label] > previous:
                self._last_activity = time.monotonic()
            if speed is not None:
                self._speed = float(speed)
            snapshot = dict(self._fractions)
            aggregate = self._aggregate(snapshot)
            current_speed = self._speed
        self._sink.report(
            ProgressUpdate(
                stage=STAGE_TRANSCODE,
                fraction=aggregate,
                renditions=snapshot,
                speed=current_speed,
            )
        )

    def complete(self, label: str) -> None:
        self.update(label, 1.0)

    def failed(self, label: str) -> None:
        # Mark it done so the aggregate can still reach 1.0 and the stall
        # detector stops waiting on a rendition that will never progress.
        with self._lock:
            self._fractions[label] = max(self._fractions.get(label, 0.0), 1.0)
            self._last_activity = time.monotonic()
        self._report_locked()

    def _aggregate(self, fractions: Mapping[str, float]) -> float:
        total_share = sum(self._shares.values())
        if total_share <= 0:
            return 0.0
        weighted = sum(
            self._shares.get(label, 0.0) * value for label, value in fractions.items()
        )
        return min(1.0, weighted / total_share)

    def _report_locked(self) -> None:
        with self._lock:
            snapshot = dict(self._fractions)
            aggregate = self._aggregate(snapshot)
            current_speed = self._speed
        self._sink.report(
            ProgressUpdate(
                stage=STAGE_TRANSCODE,
                fraction=aggregate,
                renditions=snapshot,
                speed=current_speed,
            )
        )
