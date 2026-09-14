"""
Cooperative cancellation for long-running encodes.

Why cooperative rather than "kill the thread": the work here is a tree of
subprocesses (ffmpeg, packager) plus a thread pool. A token that every blocking
call checks is the only mechanism that shuts the tree down in order — stop
admitting new renditions, terminate the running subprocesses, then unwind. A
hard thread kill would leave orphaned ffmpeg processes holding GPU sessions and
scratch space, which on a self-hosted machine is the owner's desktop.

Cancellation has two independent sources, and both are needed:

- **The owner** (dashboard cancel, CLI cancel) — delivered through the job's
  queue state on the next poll.
- **The server** — a superseded attempt or an expired lease. This one is not
  optional: :func:`is_lease_lost` is the reason the engine refuses to keep
  uploading bytes that a newer attempt may already have replaced.
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Optional

from openvod_transcoder.errors import CancelledError


class CancellationToken:
    """A one-way flag any blocking call can poll."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._reason = ""
        self._parent: Optional[CancellationToken] = None

    def cancel(self, reason: str = "cancelled") -> None:
        if not self._event.is_set():
            self._reason = reason
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set() or bool(self._parent and self._parent.cancelled)

    @property
    def reason(self) -> str:
        if not self._event.is_set() and self._parent and self._parent.cancelled:
            return self._parent.reason
        return self._reason or "cancelled"

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise CancelledError(self.reason)

    def wait(self, timeout: float) -> bool:
        """Sleep up to ``timeout`` seconds, waking early on cancellation."""
        if self._parent is None:
            return self._event.wait(timeout)
        deadline = time.monotonic() + timeout
        while not self.cancelled:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            self._event.wait(min(remaining, 0.1))
        return True

    def child(self) -> "CancellationToken":
        """A token cancelled whenever this one is (one-way, parent → child)."""
        child = CancellationToken()
        # A parent link avoids leaking a forever-waiting daemon for every
        # successful job on a long-running self-hosted agent.
        child._parent = self
        return child


# A poll returns a non-empty reason when the attempt must stop, or None/"" to
# continue. Returning a reason rather than raising keeps the poller (an HTTP
# client, usually) free of control-flow exceptions.
CancellationProbe = Callable[[], Optional[str]]


class LeaseGuard:
    """
    Polls the API for supersession/expiry and trips a token when ownership is lost.

    Runs on its own thread because the alternative — checking between pipeline
    stages — is far too coarse: a single 4K rendition can encode for an hour, and
    the whole point is to stop *before* the lease expires rather than after, so
    the attempt never uploads or finalizes under ownership it has lost.
    """

    def __init__(
        self,
        probe: CancellationProbe,
        token: CancellationToken,
        *,
        interval: float = 60.0,
    ) -> None:
        self._probe = probe
        self._token = token
        self._interval = max(1.0, interval)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._last_reason: str = ""

    @property
    def last_reason(self) -> str:
        return self._last_reason

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="lease-guard")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            if self._token.cancelled:
                return
            try:
                reason = self._probe()
            except Exception as exc:  # noqa: BLE001 — a probe failure is not a stop signal
                print(f"[LEASE] probe failed (continuing): {exc}")
                continue
            if reason:
                self._last_reason = reason
                print(f"[LEASE] stopping work: {reason}")
                self._token.cancel(reason)
                return


def is_lease_lost(reason: Optional[str]) -> bool:
    """
    Parse a probe's reply. The API answers with one of a small vocabulary.

    Kept as a pure function over literals so the agent's *reaction* to each
    reply is checkable without a server: the important distinction is that
    ``cancelled`` and ``superseded`` both stop work, but only the latter means
    "another attempt owns this now, discard everything we produced".
    """
    if not reason:
        return False
    normalized = reason.strip().lower()
    return normalized.startswith("superseded") or normalized.startswith("lease")
