"""
The job runner: everything that happens between "this agent claimed a job" and
"the video is playable".

Ordering here is the whole design, because several of these steps are only safe
in one order:

    resolve source -> snapshot -> hash -> job identity -> encode -> package
    -> inventory -> register -> upload -> verify -> complete

Reversing any adjacent pair produces a specific bug:

- snapshot before resolve: a path that escaped the roots gets read.
- encode before hash: reusable work cannot be keyed, so a retry re-encodes.
- upload before inventory: the API has nothing to authorize a grant against.
- complete before verify: a partial upload marks a video ready.

Cancellation is checked at every boundary and the *lease* is watched on its own
thread, because a single 4K rendition can encode for an hour and the rule is to
stop **before** the lease expires — never to upload or finalize under ownership
that has been lost.
"""
from __future__ import annotations

import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from clipmux_transcoder.agent.client import AgentApiError, LeaseLost, TranscoderApiClient
from clipmux_transcoder.agent.config import AgentConfig
from clipmux_transcoder.agent.journal import RecoveryJournal
from clipmux_transcoder.cancellation import CancellationToken, LeaseGuard
from clipmux_transcoder.encoding.probe import (
    CapabilityReport,
    detect_capabilities,
    toolchain_identity,
)
from clipmux_transcoder.errors import (
    ERROR_CANCELLED,
    ERROR_SOURCE_CHANGED,
    ERROR_SOURCE_MISSING,
    ERROR_SOURCE_UNREADABLE,
    ERROR_TRANSCODE_FAILED,
    CancelledError,
    TranscodeError,
    classify_error,
)
from clipmux_transcoder.options import ProcessingOptions
from clipmux_transcoder.paths import PathPolicy, PathRejected
from clipmux_transcoder.pipeline import run_pipeline
from clipmux_transcoder.progress import ProgressSink, ProgressUpdate
from clipmux_transcoder.result import PipelineResult
from clipmux_transcoder.snapshot import (
    SnapshotPolicy,
    SourceSnapshot,
    cleanup_snapshot,
    create_snapshot,
    ensure_scratch,
    estimate_scratch_bytes,
)
from clipmux_transcoder.transfer.base import TransferError, TransferStats
from clipmux_transcoder.transfer.signed import SignedHttpTransfer

MISSING_SOURCE_CODES = (ERROR_SOURCE_MISSING, ERROR_SOURCE_CHANGED, ERROR_SOURCE_UNREADABLE)

# Mirrors `DEFAULT_TRANSCODE_LEASE_MS` / `DEFAULT_JOB_LEASE_MS` on the server.
# Used only until the first heartbeat replies with the authoritative value.
DEFAULT_LEASE_SECONDS = 20 * 60
# Safety valves. A page loop that never terminates is worse than a failure: it
# holds the machine and the lease indefinitely.
MAX_GRANT_PAGES = 200
MAX_VERIFY_PAGES = 200
# Stop this long before expiry. Long enough to unwind a thread pool and kill
# subprocesses; short enough that no upload can start inside the margin.
LEASE_STOP_MARGIN_SECONDS = 60.0


@dataclass
class ClaimedJob:
    """A claimed job as the API described it."""
    job_id: str
    video_id: str
    attempt_id: str
    options: Dict[str, Any] = field(default_factory=dict)
    source: Optional[Dict[str, Any]] = None
    playback_policy: str = "public"
    title: str = ""
    prefix: str = ""

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "ClaimedJob":
        return cls(
            job_id=str(payload.get("jobId") or ""),
            video_id=str(payload.get("videoId") or ""),
            attempt_id=str(payload.get("attemptId") or ""),
            options=dict(payload.get("options") or {}),
            source=payload.get("source"),
            playback_policy=str(payload.get("playbackPolicy") or "public"),
            title=str(payload.get("title") or ""),
            prefix=str(payload.get("prefix") or ""),
        )


@dataclass
class JobOutcome:
    job_id: str
    video_id: str
    status: str
    detail: str = ""
    hls_url: str = ""
    will_retry: bool = False

    def summary(self) -> str:
        if self.hls_url:
            return f"{self.status}: {self.video_id} -> {self.hls_url}"
        return f"{self.status}: {self.video_id} ({self.detail})" if self.detail else f"{self.status}: {self.video_id}"


class JobRunner:
    """Runs one claimed job to completion, failure, or cancellation."""

    def __init__(
        self,
        config: AgentConfig,
        client: TranscoderApiClient,
        journal: RecoveryJournal,
        *,
        capabilities: Optional[CapabilityReport] = None,
        policy: Optional[PathPolicy] = None,
    ):
        self.config = config
        self.client = client
        self.journal = journal
        self._capabilities = capabilities
        self.policy = policy or PathPolicy(config.roots)
        # Lease bookkeeping for the guard: the window comes from the server's
        # own lease duration, so the agent cannot outlive a lease it does not
        # know the length of.
        self._lease_confirmed_at: Optional[float] = None
        self._lease_window_seconds: float = DEFAULT_LEASE_SECONDS

    # ── public entry point ──────────────────────────────────────────────────

    def run(self, job: ClaimedJob, sink: Optional[ProgressSink] = None) -> JobOutcome:
        """
        Execute one job.

        Never raises for an expected failure: a typed failure is reported to the
        API and returned as an outcome. Only an unrecoverable API problem (a lost
        lease, a revoked credential) propagates, because the caller has to stop
        the whole loop for those.
        """
        work_dir = self.config.scratch_dir / job.video_id / job.attempt_id
        snapshot: Optional[SourceSnapshot] = None
        token = CancellationToken()
        guard: Optional[LeaseGuard] = None

        try:
            if sink is not None:
                sink.report(
                    ProgressUpdate(
                        stage="snapshot",
                        fraction=0.0,
                        detail=f"preparing {job.title or job.video_id}",
                    )
                )

            # 1) Resolve the source. A path that escapes the configured roots is
            #    refused here and nowhere else is it allowed to be opened.
            source_path = self._resolve_source(job)
            source_size = source_path.stat().st_size

            options = ProcessingOptions.from_dict(
                {
                    **job.options,
                    "video_id": job.video_id,
                    "attempt_id": job.attempt_id,
                    "playback_policy": job.playback_policy,
                }
                # ...then bounded by what this machine will spend. Without this
                # the operator's encoder, capacity and stall settings were
                # reported to the API and never applied to execution.
            ).with_agent_limits(self.config)

            estimate = estimate_scratch_bytes(
                source_size, len(options.resolved_heights()) or 4
            )
            if self.config.scratch_quota_bytes:
                estimate = min(estimate, self.config.scratch_quota_bytes)
            ensure_scratch(self.config.scratch_dir, estimate)

            # 2) Snapshot the original. Never a hardlink — an in-place edit of the
            #    original would change the bytes underneath the job.
            snapshot_dir = work_dir / "source"
            snapshot = create_snapshot(
                source_path,
                snapshot_dir / source_path.name,
                policy=SnapshotPolicy(),
                expected_identity=str((job.source or {}).get("identity") or ""),
            )
            # The toolchain is part of the plan identity: work encoded by an
            # FFmpeg build that is no longer installed must not be reused after
            # an agent image upgrade, because the bytes would differ.
            toolchain = toolchain_identity(self._capabilities or self._detect_capabilities())
            fingerprint = options.plan_fingerprint(toolchain=toolchain)
            self.journal.start_job(
                job.video_id,
                job.attempt_id,
                job_id=job.job_id,
                source_sha256=snapshot.sha256,
                plan_fingerprint=fingerprint,
                snapshot_path=str(snapshot.path),
            )

            # 3) Watch the lease on its own thread. The runner must never be the
            #    reason a job uploads under ownership it has lost.
            guard = LeaseGuard(
                probe=lambda: self._lease_probe(job),
                token=token,
                interval=max(30.0, self.config.heartbeat_seconds * 2),
            )
            guard.start()

            # 4) Encode and package. Transfer is a *seam*: the agent has no storage
            #    credentials, so it is handed presigned URLs per artifact.
            #
            #    Reuse is keyed on the source hash and the plan fingerprint the
            #    journal recorded for *this* attempt, so a resumed attempt
            #    re-encodes only what is missing and never mixes renditions
            #    produced under different rules.
            reusable = self.journal.reusable_across_attempts(
                job.video_id, snapshot.sha256, fingerprint
            )
            if reusable:
                print(f"♻️ resuming with {len(reusable)} completed rendition(s)")

            # A stable, per-video cache *outside* the attempt directory.
            #
            # The pipeline wipes its work directory at the start of every run, so
            # a rendition recorded at its original path is deleted before the
            # retry that wanted to reuse it can read it. Journalling a path that
            # is guaranteed to be gone is worse than not journalling at all: it
            # looks like reuse exists.
            rendition_cache = self.config.scratch_dir / job.video_id / "renditions"
            rendition_cache.mkdir(parents=True, exist_ok=True)

            def checkpoint(label: str, path: Path) -> None:
                """Persist a finished rendition the moment it exists."""
                if not path.exists():
                    return
                durable = rendition_cache / f"{label}.mp4"
                try:
                    shutil.copyfile(path, durable)
                except OSError as exc:
                    print(f"[CHECKPOINT] could not cache {label}: {exc}")
                    return
                self.journal.record_rendition(
                    job.video_id,
                    job.attempt_id,
                    label,
                    str(durable),
                    bytes_=durable.stat().st_size,
                    backend="encoded",
                )

            transfer = _GrantedTransfer(self, job, options)
            result = run_pipeline(
                snapshot.path,
                work_dir / "job",
                options,
                self._capabilities or self._detect_capabilities(),
                sink,
                token,
                snapshot=snapshot,
                transfer=transfer,
                ffmpeg="ffmpeg",
                packager="packager",
                reusable=reusable,
                on_rendition=checkpoint,
            )
            self.journal.set_job_state(job.video_id, job.attempt_id, "encoded")

            # 5) Complete. Recorded *before* sending so a lost response replays
            #    rather than vanishing.
            payload = result.as_payload()
            self.journal.record_completion(job.video_id, job.attempt_id, payload)
            response = self.client.complete(job.job_id, job.attempt_id, payload)
            self.journal.acknowledge_completion(job.video_id, job.attempt_id)
            self.journal.set_job_state(job.video_id, job.attempt_id, "completed")

            return JobOutcome(
                job_id=job.job_id,
                video_id=job.video_id,
                status="completed",
                hls_url=str(response.get("hlsUrl") or ""),
            )

        except LeaseLost as exc:
            # Not a failure to report: another attempt owns this now, and the
            # server already knows. Reporting would risk clobbering the newer
            # attempt's state.
            self.journal.set_job_state(job.video_id, job.attempt_id, "abandoned")
            return JobOutcome(
                job_id=job.job_id,
                video_id=job.video_id,
                status="superseded",
                detail=str(exc),
            )

        except CancelledError as exc:
            self.journal.set_job_state(job.video_id, job.attempt_id, "abandoned")
            # Cancellation is not a failure. The API maps it to `cancelled`, and
            # reporting it as a failure would produce a `video.failed` event the
            # owner never asked for.
            try:
                self.client.fail(
                    job.job_id,
                    job.attempt_id,
                    message=str(exc) or "cancelled",
                    error_code=ERROR_CANCELLED,
                )
            except (AgentApiError, LeaseLost):
                pass
            return JobOutcome(
                job_id=job.job_id,
                video_id=job.video_id,
                status="cancelled",
                detail=str(exc),
            )

        except Exception as exc:  # noqa: BLE001 — every failure is reported, none escapes
            return self._report_failure(job, exc)

        finally:
            if guard is not None:
                guard.stop()
            if snapshot is not None:
                # The snapshot is ours to remove; the original never was.
                cleanup_snapshot(snapshot)
            self._cleanup_work_dir(work_dir, keep_on_failure=True)

    # ── source resolution ───────────────────────────────────────────────────

    def _resolve_source(self, job: ClaimedJob) -> Path:
        """Local files come from disk; r2/url sources are downloaded to scratch."""
        source = job.source or {}
        kind = str(source.get("kind") or "")

        if kind == "local" or (not kind and source.get("relativePath")):
            root_name = str(source.get("rootName") or "")
            relative = str(source.get("relativePath") or "")
            root = self.policy.root_named(root_name) if root_name else None
            if root is None:
                raise TranscodeError(
                    ERROR_SOURCE_MISSING,
                    f'the folder "{root_name}" is not configured on this machine',
                )
            try:
                return self.policy.resolve(root.path / relative)
            except PathRejected as exc:
                code = (
                    ERROR_SOURCE_MISSING
                    if exc.reason in ("NOT_FOUND", "OUTSIDE_ROOTS")
                    else ERROR_SOURCE_UNREADABLE
                )
                # The message deliberately omits the absolute path: it is
                # returned to the dashboard, which never shows host paths.
                raise TranscodeError(code, f"{relative}: {exc.message}") from exc

        source_id = str(source.get("id") or "")
        if not source_id:
            raise TranscodeError(ERROR_SOURCE_MISSING, "job has no usable source")

        grant = self.client.source_grant(source_id)
        download_dir = self.config.scratch_dir / job.video_id / job.attempt_id / "download"
        download_dir.mkdir(parents=True, exist_ok=True)
        target = download_dir / (str(source.get("fileName") or "source.bin"))

        if grant.get("kind") == "url":
            from clipmux_transcoder.utils.network import download_public_url

            download_public_url(str(grant.get("url") or ""), str(target))
        else:
            self._download(grant.get("url"), target)
        return target

    def _download(self, url: Optional[str], target: Path) -> None:
        import requests

        if not url:
            raise TranscodeError(ERROR_SOURCE_MISSING, "the API issued no download URL")
        with requests.get(url, stream=True, timeout=(15, 900)) as response:
            response.raise_for_status()
            with open(target, "wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        handle.write(chunk)

    # ── lease and progress ──────────────────────────────────────────────────

    def _lease_probe(self, job: ClaimedJob) -> Optional[str]:
        """
        Ask the API whether this attempt still owns the job.

        Two properties the earlier version lacked, both of which made the guard
        decorative rather than protective:

        1. **The probe names the job.** A beat with no `progress` block is a
           *liveness* beat: the server records the agent as seen and answers
           `leased: false` without consulting any job. Reading `stop` from that
           reply proves nothing about this attempt. The probe now sends the
           job and attempt ids, so the server's answer is about this job.
        2. **Silence is not permission.** A network outage previously returned
           `None` forever, so an agent partitioned from the API would happily
           encode and upload for hours after its lease had been reclaimed and
           handed to another machine. The guard now tracks the last *confirmed*
           lease and stops before it expires.

        A single failed poll is still not a stop signal — that would kill an
        hour-long encode over one timeout — but a failure that outlasts the lease
        is.
        """
        remaining = self._lease_remaining_seconds()
        if remaining is not None and remaining <= 0:
            return (
                "lease expired without confirmation from the API "
                "(no successful heartbeat within the lease window)"
            )

        try:
            reply = self.client.heartbeat(
                progress={"jobId": job.job_id, "attemptId": job.attempt_id, "stage": "running"}
            )
        except (AgentApiError, LeaseLost) as exc:
            print(f"[LEASE] probe failed (continuing until the lease runs out): {exc}")
            return None

        if not reply.get("leased", True):
            return str(reply.get("reason") or "lease-lost")

        self._confirm_lease(reply)
        return None

    def _confirm_lease(self, reply: Dict[str, Any]) -> None:
        """Record that the API affirmed ownership, and for how long."""
        self._lease_confirmed_at = time.monotonic()
        lease_seconds = reply.get("leaseSeconds")
        self._lease_window_seconds = (
            float(lease_seconds) if isinstance(lease_seconds, (int, float)) and lease_seconds > 0
            else DEFAULT_LEASE_SECONDS
        )

    def _lease_remaining_seconds(self) -> Optional[float]:
        """
        Seconds left on the last confirmed lease, or ``None`` when none was ever
        confirmed (a cold start, where the claim itself is the confirmation).
        """
        if self._lease_confirmed_at is None:
            return None
        elapsed = time.monotonic() - self._lease_confirmed_at
        # A margin, so the agent stops *before* expiry rather than racing it: the
        # rule is never to upload or finalize under ownership that may already
        # have been reclaimed.
        return self._lease_window_seconds - LEASE_STOP_MARGIN_SECONDS - elapsed

    def heartbeat_progress(self, job: ClaimedJob, update: ProgressUpdate) -> Optional[str]:
        """
        Send a beat carrying current progress. Returns a stop reason, if any.

        Always sent, including in quiet mode: `--quiet` suppresses *output*, and
        a job whose lease silently lapsed because the operator wanted less noise
        would be a far worse outcome than a few suppressed log lines. The server
        answers `stop: true` when the attempt has been superseded or its lease is
        gone, and ignoring a successful response that says so was the defect —
        the agent kept encoding work that could never be published.
        """
        try:
            reply = self.client.heartbeat(
                progress={"jobId": job.job_id, "attemptId": job.attempt_id, **update.as_payload()}
            )
        except LeaseLost as exc:
            return f"superseded: {exc}"
        except AgentApiError as exc:
            print(f"[HEARTBEAT] failed (non-fatal): {exc}")
            return None

        if reply.get("stop"):
            return str(reply.get("reason") or "lease-lost")
        self._confirm_lease(reply)
        return None

    # ── failure reporting ───────────────────────────────────────────────────

    def _report_failure(self, job: ClaimedJob, exc: BaseException) -> JobOutcome:
        code = classify_error(exc)
        message = str(exc) or type(exc).__name__
        print(f"❌ {job.video_id}: [{code}] {message}")

        try:
            reply = self.client.fail(
                job.job_id, job.attempt_id, message=message, error_code=code
            )
        except LeaseLost:
            self.journal.set_job_state(job.video_id, job.attempt_id, "abandoned")
            return JobOutcome(
                job_id=job.job_id,
                video_id=job.video_id,
                status="superseded",
                detail="attempt was superseded while failing",
            )
        except AgentApiError as api_error:
            # The API could not be told. The journal keeps the job unfinished so
            # the reconcile path retries the report rather than losing it.
            print(f"[FAIL] could not report failure: {api_error}")
            self.journal.set_job_state(job.video_id, job.attempt_id, "failed-unreported")
            return JobOutcome(
                job_id=job.job_id,
                video_id=job.video_id,
                status="failed",
                detail=f"{code}: {message}",
            )

        self.journal.set_job_state(job.video_id, job.attempt_id, "failed")
        return JobOutcome(
            job_id=job.job_id,
            video_id=job.video_id,
            status="failed",
            detail=f"{code}: {message}",
            will_retry=bool(reply.get("willRetry")),
        )

    # ── housekeeping ────────────────────────────────────────────────────────

    def _cleanup_work_dir(self, work_dir: Path, *, keep_on_failure: bool) -> None:
        """
        Remove a successful work directory; keep a failed one for inspection.

        Retention is bounded because a self-hosted machine's disk is the owner's:
        a week of failed 4K work directories fills a laptop.
        """
        job = work_dir
        if not job.exists():
            return
        succeeded = any(
            (job / name).exists() for name in ("output",)
        ) and not keep_on_failure
        if succeeded:
            shutil.rmtree(job, ignore_errors=True)
            return
        cutoff = time.time() - self.config.failed_retention_days * 86400
        try:
            if job.stat().st_mtime < cutoff:
                shutil.rmtree(job, ignore_errors=True)
        except OSError:
            pass

    def cleanup_stale(self) -> int:
        """Delete failed work directories past the retention window."""
        removed = 0
        cutoff = time.time() - self.config.failed_retention_days * 86400
        base = self.config.scratch_dir
        if not base.exists():
            return 0
        for entry in base.iterdir():
            if not entry.is_dir():
                continue
            try:
                if entry.stat().st_mtime >= cutoff:
                    continue
            except OSError:
                continue
            # Only directories that are not the working set of an unfinished job.
            if any(
                unfinished.video_id == entry.name
                for unfinished in self.journal.unfinished_jobs(limit=100)
            ):
                continue
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
        return removed

    def _detect_capabilities(self) -> CapabilityReport:
        if self._capabilities is None:
            self._capabilities = detect_capabilities(
                scratch_dir=self.config.scratch_dir
            )
        return self._capabilities


class _GrantedTransfer:
    """
    The transfer the agent hands the engine.

    Implemented as an adapter rather than by teaching the engine about grants,
    because the engine must not know how bytes leave the machine — that is the
    seam that lets the same pipeline run under Modal's bucket credentials. Here it
    registers the inventory, asks for exactly those URLs, uploads against them,
    and verifies before returning success.
    """

    def __init__(self, runner: JobRunner, job: ClaimedJob, options: ProcessingOptions):
        self.runner = runner
        self.job = job
        self.options = options

    def upload_artifacts(self, output_dir: Path, relative_paths, *, already_uploaded=frozenset()):
        """
        Register, upload and verify — in bounded pages.

        Paging is not an optimisation. The server issues at most
        `GRANT_BATCH_SIZE` URLs per call, so a single-grant-page implementation
        uploads the first 250 objects and then fails every remaining one with
        "no upload grant issued". A normal two-hour lecture is roughly 9,000
        objects, so the single-page version worked only for short clips and
        reported a partial upload for everything else.

        Registration is paged too (the first page replaces, later pages append),
        and verification is paged because one request cannot HEAD 9,000 objects
        inside a Worker's budgets.

        Ordering is preserved end to end: segments before playlists, so a player
        that fetches the master manifest the instant it appears finds every
        segment it names already present.
        """
        from clipmux_transcoder.result import build_inventory

        client = self.runner.client
        journal = self.runner.journal
        video_id, attempt_id = self.job.video_id, self.job.attempt_id

        # Re-derive the inventory from disk rather than trusting a caller's list:
        # the list and the files must agree, and the files are the truth.
        artifacts = build_inventory(output_dir)
        for artifact in artifacts:
            journal.record_artifact(
                video_id, attempt_id, artifact.path,
                size_bytes=artifact.size, checksum=artifact.checksum,
            )

        already_verified = journal.verified_paths(video_id, attempt_id)
        pending = [
            artifact for artifact in artifacts if artifact.path not in already_verified
        ]

        registration = client.register_inventory(
            self.job.job_id,
            [
                {
                    "path": artifact.path,
                    "size": artifact.size,
                    "checksum": artifact.checksum,
                    "role": artifact.role,
                }
                for artifact in artifacts
            ],
        )
        inventory_id = str(registration.get("inventoryId") or "")
        if not inventory_id:
            raise AgentApiError(0, "the API did not return an inventory id")

        failed_all: List[TransferError] = []
        uploaded_total = 0
        skipped_total = len(artifacts) - len(pending)

        # ── upload, one granted page at a time ──────────────────────────────
        # A page is uploaded and acknowledged before the next is requested, so
        # progress survives a restart: the server only issues grants for
        # artifacts it has not seen verified, and the journal records what this
        # machine believes it sent.
        for _ in range(MAX_GRANT_PAGES):
            page = client.artifact_grants(inventory_id)
            grants = page.get("grants") or []
            if not grants:
                break

            grant_map = {str(entry.get("path")): str(entry.get("url")) for entry in grants}
            transfer = SignedHttpTransfer(
                grant_map,
                renew=lambda paths, _id=inventory_id: self._renew(_id),
                max_workers=self.runner.config.upload_concurrency,
            )
            page_paths = list(grant_map)
            stats = transfer.upload_artifacts(output_dir, page_paths)

            uploaded = [
                path for path in page_paths if path not in stats.failed_paths()
            ]
            if uploaded:
                client.mark_uploaded(
                    inventory_id,
                    uploaded,
                    {
                        artifact.path: artifact.checksum
                        for artifact in artifacts
                        if artifact.checksum
                    },
                )
                for path in uploaded:
                    journal.record_artifact(video_id, attempt_id, path, uploaded=True)

            uploaded_total += len(uploaded)
            failed_all.extend(stats.failed)

            if stats.failed:
                # A page with failures is not retried in place: the failing
                # artifacts stay unverified, so a later attempt re-requests them
                # rather than spinning on the same page forever.
                break
            if not page.get("remaining"):
                break

        # ── verify, one bounded batch at a time ─────────────────────────────
        verification_failures: List[Dict[str, Any]] = []
        status = "registering"
        for _ in range(MAX_VERIFY_PAGES):
            verification = client.verify_inventory(inventory_id)
            status = str(verification.get("status") or "registering")
            verification_failures = list(verification.get("failures") or [])

            for entry in verification_failures:
                path = str(entry.get("path"))
                if path:
                    journal.record_artifact(video_id, attempt_id, path, verified=False)

            reported_verified = self._reported_verified(verification, artifacts)
            for path in reported_verified:
                journal.record_artifact(video_id, attempt_id, path, verified=True)

            if status == "verified" or not verification.get("remaining"):
                break

        total = len(artifacts)
        if status != "verified":
            preview = ", ".join(str(entry.get("path")) for entry in verification_failures[:5])
            return TransferStats(
                total=total,
                uploaded=uploaded_total,
                skipped=skipped_total,
                failed=[
                    *failed_all,
                    *[
                        TransferError(
                            path=str(entry.get("path")),
                            message=str(entry.get("reason")),
                        )
                        for entry in verification_failures
                    ],
                    *(
                        []
                        if verification_failures
                        else [
                            TransferError(
                                path="(inventory)",
                                message=f"inventory did not reach verified (status: {status})"
                                + (f"; not uploaded: {preview}" if preview else ""),
                            )
                        ]
                    ),
                ],
            )

        return TransferStats(total=total, uploaded=uploaded_total, skipped=skipped_total)

    @staticmethod
    def _reported_verified(
        verification: Dict[str, Any], artifacts: List[Any]
    ) -> List[str]:
        """
        Paths the server now considers verified.

        Derived from the *failure* list rather than from a success list the API
        does not return: anything not reported as failed and no longer pending is
        verified. Inferring it this way keeps the journal useful without asking
        the server to echo thousands of paths back on every page.
        """
        failed = {str(entry.get("path")) for entry in verification.get("failures") or []}
        return [artifact.path for artifact in artifacts if artifact.path not in failed]

    def _renew(self, inventory_id: str) -> Dict[str, str]:
        grants = self.runner.client.artifact_grants(inventory_id).get("grants") or []
        return {str(entry.get("path")): str(entry.get("url")) for entry in grants}


def reusable_renditions(
    journal: RecoveryJournal,
    job: ClaimedJob,
    options: ProcessingOptions,
    *,
    toolchain: str = "",
) -> Dict[str, str]:
    """
    Encoded work that a retried attempt may reuse.

    Keyed on the source hash, the plan fingerprint and the toolchain identity, so
    a changed ladder, a changed source or an upgraded FFmpeg invalidates it.
    That is the difference between "resume" and "mix two different encodes
    together".
    """
    job_row = journal.get_job(job.video_id, job.attempt_id)
    if not job_row:
        return {}
    return journal.reusable_renditions(
        job.video_id,
        job.attempt_id,
        job_row.source_sha256,
        options.plan_fingerprint(toolchain=toolchain),
    )


__all__ = [
    "ClaimedJob",
    "JobOutcome",
    "JobRunner",
    "MISSING_SOURCE_CODES",
    "reusable_renditions",
]
