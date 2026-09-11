"""
The persistent agent loop.

Responsibilities, in the order they matter:

1. **Stay alive.** A crash must not take the machine's agent with it, and a
   network outage must not either. Every remote failure is logged and retried; the
   loop only stops for a revoked credential or an operator signal.
2. **Answer control requests.** Folder browsing is the owner's window into this
   machine, and an unanswered request is a spinner in the dashboard.
3. **Keep the lease.** A heartbeat thread runs independently of job execution,
   because the work itself blocks for hours.
4. **Run one job at a time by default.** `capacity_jobs` is the operator's
   explicit choice; the default of one is what keeps a workstation usable.
5. **Reconcile before resuming.** After a restart, an attempt whose lease was
   reclaimed must be abandoned locally rather than resumed, or two workers write
   into one prefix.
"""
from __future__ import annotations

import platform
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from openvod_transcoder.agent.client import (
    AgentApiError,
    AuthenticationFailed,
    LeaseLost,
    TranscoderApiClient,
)
from openvod_transcoder.agent.config import AgentConfig
from openvod_transcoder.agent.journal import RecoveryJournal
from openvod_transcoder.agent.runner import ClaimedJob, JobOutcome, JobRunner
from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.encoding.probe import CapabilityReport, detect_capabilities
from openvod_transcoder.paths import PathPolicy, PathRejected
from openvod_transcoder.progress import CallbackProgress, NullProgress, ProgressUpdate

DEFAULT_BROWSE_LIMIT = 200


@dataclass
class DaemonStats:
    polls: int = 0
    claims: int = 0
    completed: int = 0
    failed: int = 0


class TranscoderAgent:
    """Polls, claims and runs work until stopped."""

    def __init__(
        self,
        config: AgentConfig,
        client: TranscoderApiClient,
        journal: RecoveryJournal,
        *,
        capabilities: Optional[CapabilityReport] = None,
        verbose: bool = True,
    ):
        self.config = config
        self.client = client
        self.journal = journal
        self.verbose = verbose
        self._stop = threading.Event()
        self._capabilities = capabilities
        self._policy = PathPolicy(config.roots)
        self._runner = JobRunner(
            config, client, journal, capabilities=capabilities, policy=self._policy
        )
        self.stats = DaemonStats()
        # Attempts the API still considers ours after a restart. Held across
        # ticks so a failed resume is retried rather than forgotten.
        self._resumable: List[Dict[str, str]] = []

    # ── lifecycle ───────────────────────────────────────────────────────────

    def stop(self) -> None:
        self._stop.set()

    def capabilities(self) -> Dict[str, Any]:
        """
        Probe once per process and reuse.

        A full probe runs real encodes, which is correct at startup and wasteful
        on every heartbeat. Warm-up is also what makes the first job fast: the
        encoder is already loaded when work arrives.
        """
        if self._capabilities is None:
            self._log("probing encoders (this runs real test encodes)...")
            self._capabilities = detect_capabilities(scratch_dir=self.config.scratch_dir)
        return self._capabilities.to_payload()

    def reconcile(self) -> None:
        """
        Re-establish ownership for anything the journal thinks is in flight.

        The API is the authority. An attempt it no longer recognises is marked
        abandoned locally, which is what stops a restarted agent from resuming an
        encode whose output prefix has already been superseded.
        """
        unfinished = self.journal.unfinished_jobs()
        if not unfinished:
            return

        attempts = [
            {"jobId": job.job_id, "attemptId": job.attempt_id} for job in unfinished
        ]

        try:
            reply = self.client.reconcile(attempts)
        except (AgentApiError, LeaseLost) as exc:
            self._log(f"reconcile failed (will retry): {exc}")
            return

        decisions = {str(entry.get("attemptId")): entry for entry in reply.get("decisions") or []}
        resumable: List[Dict[str, str]] = []
        for job in unfinished:
            decision = decisions.get(job.attempt_id)
            if decision and decision.get("resume"):
                # The API still recognises this attempt, so the work is ours to
                # finish. Merely *reporting* that and then claiming something
                # else leaves the accepted attempt holding a lease until it
                # expires — during which its video is stuck and its capacity
                # slot is consumed.
                resumable.append({"jobId": job.job_id, "attemptId": job.attempt_id})
                continue
            self.journal.set_job_state(job.video_id, job.attempt_id, "abandoned")
            if decision:
                self._log(f"abandoned attempt {job.attempt_id} ({decision.get('reason')})")

        self._resumable = resumable
        if resumable:
            self._log(f"{len(resumable)} attempt(s) still owned by this agent; resuming")

    def run_forever(self) -> None:
        self._log(
            f"agent online: api={self.config.api_url} "
            f"roots={[root.name for root in self.config.roots]} "
            f"capacity={self.config.capacity_jobs} job(s), "
            f"{self.config.capacity_renditions} rendition(s)"
        )
        self.capabilities()
        self.reconcile()

        heartbeat = threading.Thread(target=self._heartbeat_loop, daemon=True, name="heartbeat")
        heartbeat.start()

        try:
            while not self._stop.is_set():
                try:
                    self._tick()
                except AuthenticationFailed as exc:
                    # Retrying a revoked credential is pointless and noisy; the
                    # owner has to re-pair.
                    self._log(f"credential rejected: {exc}. Re-pair with a new code.")
                    return
                except Exception as exc:  # noqa: BLE001 — the loop must survive
                    self._log(f"tick failed (continuing): {exc}")
                self._stop.wait(self.config.poll_seconds)
        except KeyboardInterrupt:
            self._log("stopping on interrupt")
        finally:
            self.stop()
            self._log(
                f"agent stopped (polls={self.stats.polls} claims={self.stats.claims} "
                f"completed={self.stats.completed} failed={self.stats.failed})"
            )

    # ── one iteration ───────────────────────────────────────────────────────

    def _tick(self) -> None:
        poll = self.client.poll()
        self.stats.polls += 1

        # Finish what we already own before taking anything new. The server's
        # `claim` also returns an existing attempt (it matches on attempt id),
        # so this is the explicit path rather than a lucky one.
        while self._resumable:
            pending = self._resumable[0]
            try:
                claim = self.client.resume(
                    pending.get("jobId") or "", pending.get("attemptId") or ""
                )
            except LeaseLost:
                claim = None
            if not claim:
                # Eligibility changed (lease reclaimed, video deleted). Drop it
                # here and let the server tell us again on the next reconcile.
                self._resumable.pop(0)
                self.journal.set_job_state(
                    _video_for(self.journal, pending.get("attemptId", "")),
                    pending.get("attemptId", ""),
                    "abandoned",
                )
                continue
            self._resumable.pop(0)
            job = ClaimedJob.from_payload(claim)
            self.stats.claims += 1
            self._log(f"resuming {job.video_id} (attempt {job.attempt_id})")
            token = CancellationToken()
            outcome = self._runner.run(job, self._progress_sink(job, token), token)
            self._record(outcome)

        for control in poll.get("controls") or []:
            self._answer_control(control)

        free = int((poll.get("capacity") or {}).get("free") or 0)
        if free <= 0:
            return

        for _ in range(free):
            claim = self.client.claim()
            if not claim:
                return
            self.stats.claims += 1
            job = ClaimedJob.from_payload(claim)
            self._log(
                f"claimed {job.video_id} (attempt {job.attempt_id}, "
                f"{job.source.get('kind') if job.source else 'unknown'} source)"
            )
            # The token is created here rather than inside the runner so the
            # progress sink can trip it when the API says the attempt is gone.
            token = CancellationToken()
            outcome = self._runner.run(job, self._progress_sink(job, token), token)
            self._record(outcome)

    def _record(self, outcome: JobOutcome) -> None:
        if outcome.status == "completed":
            self.stats.completed += 1
        elif outcome.status == "failed":
            self.stats.failed += 1
        self._log(f"{outcome.status}: {outcome.summary()}")

    # ── control requests ────────────────────────────────────────────────────

    def _answer_control(self, control: Dict[str, Any]) -> None:
        control_id = str(control.get("id") or "")
        kind = str(control.get("kind") or "")
        request = control.get("request") or {}
        if not control_id:
            return

        try:
            if kind == "browse":
                response = self._browse(request)
            elif kind == "doctor":
                response = {"capabilities": self.capabilities()}
            else:
                self.client.answer_control(control_id, error=f"unsupported request: {kind}")
                return
            self.client.answer_control(control_id, response=response)
        except PathRejected as exc:
            # A refused path is a normal answer, not a crash: the dashboard shows
            # the reason so the owner knows why a folder cannot be opened.
            self.client.answer_control(control_id, error=exc.message)
        except Exception as exc:  # noqa: BLE001 — one bad request must not stop the loop
            self.client.answer_control(control_id, error=str(exc))

    def _browse(self, request: Dict[str, Any]) -> Dict[str, Any]:
        root_name = str(request.get("rootName") or "") or None
        path = str(request.get("path") or ".") or "."

        root = self._policy.root_named(root_name) if root_name else None
        if root is None and root_name:
            raise PathRejected("OUTSIDE_ROOTS", f'the folder "{root_name}" is not mounted here')
        if root is None:
            root = self._policy.roots[0]

        # `.` means the root itself; any other value is root-relative, and the
        # policy refuses anything that escapes.
        target = root.path if path in (".", "") else root.path / path
        listing = self._policy.list_directory(
            target,
            limit=min(DEFAULT_BROWSE_LIMIT, int(request.get("limit") or DEFAULT_BROWSE_LIMIT)),
            cursor=str(request.get("cursor") or ""),
        )
        payload = listing.as_payload()
        payload["roots"] = [{"name": item.name} for item in self._policy.roots]
        return payload

    # ── heartbeat ───────────────────────────────────────────────────────────

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(self.config.heartbeat_seconds):
            try:
                self.client.heartbeat(
                    capabilities=self.capabilities(),
                    hostname=socket.gethostname(),
                    agent_version=_agent_version(),
                )
            except AuthenticationFailed:
                return
            except Exception as exc:  # noqa: BLE001 — a beat failure is never fatal
                self._log(f"heartbeat failed (non-fatal): {exc}")
            self._cleanup()

    def _cleanup(self) -> None:
        removed = self._runner.cleanup_stale()
        if removed:
            self._log(f"removed {removed} expired work directory(ies)")

        # Replay completions whose response never arrived. The API is idempotent
        # for these, so a duplicate is harmless and a replay is the difference
        # between a ready video and a job that waits for its lease to expire.
        for entry in self.journal.unacknowledged_completions():
            try:
                self.client.complete(
                    _job_id_for(self.journal, entry["video_id"], entry["attempt_id"]),
                    entry["attempt_id"],
                    entry["payload"],
                )
                self.journal.acknowledge_completion(entry["video_id"], entry["attempt_id"])
                self._log(f"replayed completion for {entry['video_id']}")
            except Exception as exc:  # noqa: BLE001 — replayed again next pass
                self._log(f"completion replay failed (will retry): {exc}")

    # ── helpers ─────────────────────────────────────────────────────────────

    def _progress_sink(self, job: ClaimedJob, token: CancellationToken):
        """
        Forward progress to the API, and stop the job if the reply says to.

        Built regardless of verbosity. Progress beats are how the server keeps
        the lease alive *and* how a cancellation is delivered, so suppressing
        them in quiet mode would make `--quiet` a correctness bug rather than a
        preference — and a successful reply saying `stop: true` was previously
        discarded, so the agent kept encoding work that could never be published.
        """

        def report(update: ProgressUpdate) -> None:
            reason = self._runner.heartbeat_progress(job, update)
            if reason:
                self._log(f"stopping work: {reason}")
                token.cancel(reason)

        return CallbackProgress(report)

    def _log(self, message: str) -> None:
        if self.verbose:
            print(f"[agent] {message}", flush=True)


def _video_for(journal: RecoveryJournal, attempt_id: str) -> str:
    """The video a journalled attempt belongs to, for state bookkeeping."""
    for job in journal.unfinished_jobs(limit=100):
        if job.attempt_id == attempt_id:
            return job.video_id
    return ""


def _job_id_for(journal: RecoveryJournal, video_id: str, attempt_id: str) -> str:
    """The server-side job id recorded when the attempt started."""
    job = journal.get_job(video_id, attempt_id)
    return job.job_id if job else ""


def _agent_version() -> str:
    try:
        from openvod_transcoder import __version__

        return __version__
    except Exception:  # noqa: BLE001
        return "unknown"


def host_description() -> Dict[str, str]:
    return {
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "python": platform.python_version(),
    }


__all__ = ["DaemonStats", "TranscoderAgent", "host_description"]
