"""
Lease protection and paged transfer in the agent.

Both of these were *decorative* rather than protective in the reviewed revision,
and both failures share a shape: code that looked like it enforced something and
did not.

- The lease guard sent a heartbeat with no job identity, so the server's answer
  was about the *agent*, not the attempt. It ignored network failures forever, so
  an agent partitioned from the API would encode and upload for hours after its
  lease had been reclaimed. And a successful reply saying `stop: true` was
  discarded.
- The transfer asked for one page of grants and then attempted the whole
  inventory. A 251-artifact reproduction uploaded 250 and failed the rest with
  "no upload grant issued" — and a normal two-hour lecture is roughly 9,000
  objects.
"""
from pathlib import Path
from typing import Any, Dict, List

import pytest

from openvod_transcoder.agent.client import AgentApiError, ApiConfig, LeaseLost, TranscoderApiClient
from openvod_transcoder.agent.config import AgentConfig
from openvod_transcoder.agent.journal import RecoveryJournal
from openvod_transcoder.agent.runner import (
    DEFAULT_LEASE_SECONDS,
    LEASE_STOP_MARGIN_SECONDS,
    ClaimedJob,
    JobRunner,
)
from openvod_transcoder.paths import PathPolicy, Root
from openvod_transcoder.progress import ProgressUpdate
from openvod_transcoder.result import Artifact


class FakeClient:
    """Records calls and returns scripted replies."""

    def __init__(self, heartbeat_replies: List[Dict[str, Any]] | None = None):
        self.calls: List[Dict[str, Any]] = []
        self.heartbeat_replies = list(heartbeat_replies or [])
        self.completes: List[Dict[str, Any]] = []

    def _next_heartbeat(self) -> Dict[str, Any]:
        if self.heartbeat_replies:
            return self.heartbeat_replies.pop(0)
        return {"ok": True, "leased": True, "leaseSeconds": DEFAULT_LEASE_SECONDS}

    def heartbeat(self, **kwargs):
        self.calls.append({"method": "heartbeat", **kwargs})
        return self._next_heartbeat()

    def fail(self, job_id, attempt_id, **kwargs):
        self.completes.append({"job_id": job_id, "attempt_id": attempt_id, **kwargs})
        return {"applied": True}

    def complete(self, job_id, attempt_id, payload):
        self.completes.append({"job_id": job_id, "attempt_id": attempt_id, "payload": payload})
        return {"applied": True, "hlsUrl": ""}

    def register_inventory(self, job_id, artifacts):
        self.calls.append({"method": "register_inventory", "artifacts": artifacts})
        return {"inventoryId": "inv-1", "items": len(artifacts)}

    def artifact_grants(self, inventory_id, limit=0):
        self.calls.append({"method": "grants", "limit": limit})
        return {"grants": [], "remaining": 0}

    def mark_uploaded(self, inventory_id, paths, checksums=None):
        return {"updated": len(paths)}

    def verify_inventory(self, inventory_id, limit=0):
        return {"status": "verified", "remaining": 0, "failures": []}


def make_runner(tmp_path: Path, client: FakeClient | None = None) -> JobRunner:
    root = tmp_path / "media"
    root.mkdir(parents=True, exist_ok=True)
    config = AgentConfig(
        api_url="https://api.example.com",
        token="agt_x_y",
        roots=[Root(name="media", path=root)],
        scratch_dir=tmp_path / "scratch",
        journal_path=tmp_path / "journal.sqlite",
    )
    config.scratch_dir.mkdir(parents=True, exist_ok=True)
    journal = RecoveryJournal(config.journal_path)
    return JobRunner(config, client or FakeClient(), journal, policy=PathPolicy(config.roots))


def make_job() -> ClaimedJob:
    return ClaimedJob(
        job_id="job-1",
        video_id="vid-1",
        attempt_id="att-1",
        options={},
        source={"kind": "local", "rootName": "media", "relativePath": "lesson.mp4"},
        playback_policy="public",
        title="Lesson",
        prefix="videos/vid-1/attempts/att-1",
    )


class TestLeaseProbeIsJobScoped:
    def test_the_probe_names_the_job_and_attempt(self, tmp_path):
        # A beat with no job identity is a *liveness* beat: the server records
        # the agent as seen and answers without consulting any job, so reading
        # `stop` from it proves nothing about this attempt.
        client = FakeClient()
        runner = make_runner(tmp_path, client)

        runner._lease_probe(make_job())

        heartbeats = [call for call in client.calls if call["method"] == "heartbeat"]
        assert heartbeats, "the probe must send a heartbeat"
        progress = heartbeats[0]["progress"]
        assert progress["jobId"] == "job-1"
        assert progress["attemptId"] == "att-1"

    def test_a_stop_reply_is_reported_as_a_reason(self, tmp_path):
        client = FakeClient([{"ok": True, "leased": False, "reason": "superseded"}])
        runner = make_runner(tmp_path, client)
        assert runner._lease_probe(make_job()) == "superseded"

    def test_a_leased_reply_confirms_and_continues(self, tmp_path):
        client = FakeClient([{"ok": True, "leased": True, "leaseSeconds": 600}])
        runner = make_runner(tmp_path, client)
        assert runner._lease_probe(make_job()) is None
        assert runner._lease_window_seconds == 600


class TestLeaseDeadline:
    def test_silence_does_not_last_forever(self, tmp_path):
        # An agent partitioned from the API used to return `None` on every failed
        # probe and keep encoding, long after its lease had been reclaimed and
        # handed to another machine.
        runner = make_runner(tmp_path)

        class Offline(FakeClient):
            def heartbeat(self, **kwargs):
                raise AgentApiError(0, "network unreachable")

        runner.client = Offline()
        runner._confirm_lease({"leaseSeconds": 60})
        # Pretend the confirmation was long ago.
        runner._lease_confirmed_at -= 60 + LEASE_STOP_MARGIN_SECONDS + 1

        reason = runner._lease_probe(make_job())
        assert reason is not None
        assert "lease expired" in reason

    def test_a_single_failed_probe_does_not_stop_a_long_encode(self, tmp_path):
        runner = make_runner(tmp_path)

        class Flaky(FakeClient):
            def heartbeat(self, **kwargs):
                raise AgentApiError(0, "timeout")

        runner.client = Flaky()
        runner._confirm_lease({"leaseSeconds": 1200})
        assert runner._lease_probe(make_job()) is None

    def test_the_deadline_leaves_a_margin_before_expiry(self, tmp_path):
        runner = make_runner(tmp_path)
        runner._confirm_lease({"leaseSeconds": 100})
        remaining = runner._lease_remaining_seconds()
        assert remaining is not None
        # Stop *before* the lease ends, never race it.
        assert remaining < 100 - LEASE_STOP_MARGIN_SECONDS + 1

    def test_an_unknown_lease_length_uses_the_server_default(self, tmp_path):
        runner = make_runner(tmp_path)
        runner._confirm_lease({})
        assert runner._lease_window_seconds == DEFAULT_LEASE_SECONDS


class TestProgressHeartbeatConsumesStop:
    def test_a_stop_reply_is_returned_so_the_job_can_be_cancelled(self, tmp_path):
        client = FakeClient([{"ok": True, "stop": True, "reason": "cancelled"}])
        runner = make_runner(tmp_path, client)
        reason = runner.heartbeat_progress(make_job(), ProgressUpdate(stage="transcode", fraction=0.5))
        assert reason == "cancelled"

    def test_a_lost_lease_is_reported_rather_than_swallowed(self, tmp_path):
        runner = make_runner(tmp_path)

        class Superseded(FakeClient):
            def heartbeat(self, **kwargs):
                raise LeaseLost(409, "superseded", "SUPERSEDED")

        runner.client = Superseded()
        reason = runner.heartbeat_progress(make_job(), ProgressUpdate(stage="transcode"))
        assert reason is not None and "superseded" in reason

    def test_a_transient_failure_is_not_a_cancellation(self, tmp_path):
        runner = make_runner(tmp_path)

        class Flaky(FakeClient):
            def heartbeat(self, **kwargs):
                raise AgentApiError(500, "server hiccup")

        runner.client = Flaky()
        assert runner.heartbeat_progress(make_job(), ProgressUpdate(stage="transcode")) is None


class TestProgressSinkAlwaysSends:
    def test_quiet_mode_still_heartbeats(self, tmp_path):
        # `--quiet` suppresses output, not correctness. A job whose lease lapsed
        # because the operator asked for less log noise would be a far worse
        # outcome than a few suppressed lines.
        from openvod_transcoder.agent.daemon import TranscoderAgent
        from openvod_transcoder.cancellation import CancellationToken

        client = FakeClient()
        runner = make_runner(tmp_path, client)
        config = runner.config
        agent = TranscoderAgent(
            config, client, runner.journal, capabilities=None, verbose=False
        )
        agent._runner = runner

        token = CancellationToken()
        sink = agent._progress_sink(make_job(), token)
        sink.report(ProgressUpdate(stage="transcode", fraction=0.5))

        assert [call for call in client.calls if call["method"] == "heartbeat"]

    def test_a_stop_reply_cancels_the_token(self, tmp_path):
        from openvod_transcoder.agent.daemon import TranscoderAgent
        from openvod_transcoder.cancellation import CancellationToken

        client = FakeClient([{"ok": True, "stop": True, "reason": "cancelled"}])
        runner = make_runner(tmp_path, client)
        agent = TranscoderAgent(
            runner.config, client, runner.journal, capabilities=None, verbose=False
        )
        agent._runner = runner

        token = CancellationToken()
        agent._progress_sink(make_job(), token).report(ProgressUpdate(stage="transcode"))
        assert token.cancelled is True


class TestPagedTransfer:
    """A multi-rendition lecture exceeds one grant page; the old code gave up."""

    def _payload(self, count: int) -> List[Artifact]:
        return [
            Artifact(path=f"seg/{index}.m4s", size=10, checksum=f"c{index}", role="segment")
            for index in range(count)
        ]

    def test_requests_grants_until_the_inventory_is_exhausted(self, tmp_path, monkeypatch):
        from openvod_transcoder.agent import runner as runner_module

        output_dir = tmp_path / "out"
        output_dir.mkdir()

        class PagedClient(FakeClient):
            def __init__(self, total: int):
                super().__init__()
                self.total = total
                self.verified: List[str] = []
                self.uploaded: List[str] = []
                self.page_size = 250
                self.grant_calls = 0

            def artifact_grants(self, inventory_id, limit=0):
                self.grant_calls += 1
                done = set(self.uploaded)
                pending = [f"seg/{i}.m4s" for i in range(self.total) if f"seg/{i}.m4s" not in done]
                page = pending[: self.page_size]
                return {
                    "grants": [{"path": path, "url": f"https://put/{path}"} for path in page],
                    "remaining": max(0, len(pending) - len(page)),
                }

            def mark_uploaded(self, inventory_id, paths, checksums=None):
                self.uploaded.extend(paths)
                return {"updated": len(paths)}

            def verify_inventory(self, inventory_id, limit=0):
                remaining = [f"seg/{i}.m4s" for i in range(self.total) if f"seg/{i}.m4s" not in self.verified]
                batch = remaining[:250]
                self.verified.extend(batch)
                still = len(remaining) - len(batch)
                return {
                    "status": "verified" if still == 0 else "registering",
                    "remaining": still,
                    "failures": [],
                }

        client = PagedClient(251)
        runner = make_runner(tmp_path, client)

        # A real file per artifact, and a real (simulated) HTTP PUT.
        def fake_inventory(_dir):
            artifacts = self._payload(251)
            for artifact in artifacts:
                path = output_dir / artifact.path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x" * artifact.size)
            return artifacts

        monkeypatch.setattr(runner_module, "run_pipeline", None, raising=False)
        import openvod_transcoder.result as result_module

        monkeypatch.setattr(result_module, "build_inventory", fake_inventory)

        class OkTransfer:
            def __init__(self, grants, **kwargs):
                self.grants = grants

            def upload_artifacts(self, directory, paths, already_uploaded=frozenset()):
                from openvod_transcoder.transfer.base import TransferStats

                return TransferStats(total=len(paths), uploaded=len(paths), skipped=0)

        monkeypatch.setattr(runner_module, "SignedHttpTransfer", OkTransfer)

        transfer = runner_module._GrantedTransfer(runner, make_job(), None)
        stats = transfer.upload_artifacts(output_dir, [])

        assert stats.complete, stats.failed
        assert len(client.uploaded) == 251
        # One page of 250 then one of 1: a single-page implementation stops here.
        assert client.grant_calls >= 2
