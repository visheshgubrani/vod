"""Agent behaviour: the recovery journal, configuration, and error mapping."""
import time
from pathlib import Path

import pytest

from clipmux_transcoder.agent.client import (
    AgentApiError,
    AuthenticationFailed,
    LeaseLost,
    _error_for,
)
from clipmux_transcoder.agent.config import AgentConfig
from clipmux_transcoder.agent.journal import RecoveryJournal


@pytest.fixture()
def journal(tmp_path: Path):
    handle = RecoveryJournal(tmp_path / "journal.sqlite")
    yield handle
    handle.close()


class TestJournalLifecycle:
    def test_a_started_job_is_recorded_with_its_identity(self, journal):
        journal.start_job(
            "vid-1", "att-1",
            job_id="job-1",
            source_sha256="abc",
            plan_fingerprint="plan-1",
            snapshot_path="/scratch/snap.mp4",
        )
        job = journal.get_job("vid-1", "att-1")
        assert job is not None
        assert (job.job_id, job.source_sha256, job.plan_fingerprint) == (
            "job-1", "abc", "plan-1",
        )
        assert job.state == "started"

    def test_state_transitions_are_visible_to_reconcile(self, journal):
        journal.start_job("vid-1", "att-1", job_id="job-1")
        journal.set_job_state("vid-1", "att-1", "encoded")
        assert journal.get_job("vid-1", "att-1").state == "encoded"

    def test_unknown_jobs_have_no_record(self, journal):
        assert journal.get_job("nope", "nope") is None

    def test_unfinished_excludes_completed_and_abandoned(self, journal):
        journal.start_job("v1", "a1")
        journal.start_job("v2", "a2")
        journal.start_job("v3", "a3")
        journal.set_job_state("v1", "a1", "completed")
        journal.set_job_state("v2", "a2", "abandoned")
        unfinished = {job.video_id for job in journal.unfinished_jobs()}
        assert unfinished == {"v3"}

    def test_forget_removes_every_row_for_the_attempt(self, journal):
        journal.start_job("v1", "a1", job_id="j1")
        journal.record_rendition("v1", "a1", "720p", "/tmp/x.mp4")
        journal.record_artifact("v1", "a1", "playlist.m3u8", size_bytes=10)
        journal.record_completion("v1", "a1", {"status": "success"})
        journal.forget_job("v1", "a1")
        assert journal.get_job("v1", "a1") is None
        assert journal.reusable_renditions("v1", "a1", "", "") == {}
        assert journal.unacknowledged_completions() == []


class TestRenditionReuse:
    def test_a_completed_rendition_is_reusable(self, journal, tmp_path):
        output = tmp_path / "video_720p.mp4"
        output.write_bytes(b"x" * 5000)
        journal.start_job("v1", "a1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "a1", "720p", str(output), bytes_=5000)

        reusable = journal.reusable_renditions("v1", "a1", "abc", "plan-1")
        assert reusable == {"720p": str(output)}

    def test_a_changed_source_invalidates_reuse(self, journal, tmp_path):
        # Reusing a rendition encoded from different bytes is worse than
        # re-encoding: the package would mix two versions of the source.
        output = tmp_path / "video_720p.mp4"
        output.write_bytes(b"x" * 5000)
        journal.start_job("v1", "a1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "a1", "720p", str(output), bytes_=5000)
        assert journal.reusable_renditions("v1", "a1", "different", "plan-1") == {}

    def test_a_changed_plan_invalidates_reuse(self, journal, tmp_path):
        output = tmp_path / "video_720p.mp4"
        output.write_bytes(b"x" * 5000)
        journal.start_job("v1", "a1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "a1", "720p", str(output), bytes_=5000)
        assert journal.reusable_renditions("v1", "a1", "abc", "plan-2") == {}

    def test_a_deleted_file_is_not_reusable(self, journal, tmp_path):
        # A journal entry whose file is gone would let the pipeline skip a
        # rendition that does not exist.
        output = tmp_path / "gone.mp4"
        output.write_bytes(b"x" * 5000)
        journal.start_job("v1", "a1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "a1", "720p", str(output), bytes_=5000)
        output.unlink()
        assert journal.reusable_renditions("v1", "a1", "abc", "plan-1") == {}

    def test_a_truncated_file_is_not_reusable(self, journal, tmp_path):
        output = tmp_path / "short.mp4"
        output.write_bytes(b"x" * 10)
        journal.start_job("v1", "a1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "a1", "720p", str(output), bytes_=10)
        assert journal.reusable_renditions("v1", "a1", "abc", "plan-1") == {}


class TestArtifactTracking:
    def test_verified_paths_survive_a_restart(self, journal, tmp_path):
        journal.start_job("v1", "a1")
        journal.record_artifact("v1", "a1", "playlist.m3u8", size_bytes=10, verified=True)
        journal.record_artifact("v1", "a1", "video_720p/1.m4s", size_bytes=20)
        assert journal.verified_paths("v1", "a1") == {"playlist.m3u8"}

    def test_uploaded_is_distinct_from_verified(self, journal):
        # "I uploaded it" and "the server confirmed it is there" are different
        # claims, and only the second may gate publication.
        journal.start_job("v1", "a1")
        journal.record_artifact("v1", "a1", "a.m4s", uploaded=True)
        assert journal.uploaded_paths("v1", "a1") == {"a.m4s"}
        assert journal.verified_paths("v1", "a1") == set()

    def test_an_empty_checksum_does_not_erase_a_recorded_one(self, journal):
        journal.start_job("v1", "a1")
        journal.record_artifact("v1", "a1", "a.m4s", checksum="deadbeef")
        journal.record_artifact("v1", "a1", "a.m4s", size_bytes=5)
        rows = journal._query_all(
            "SELECT checksum FROM artifact WHERE video_id = ? AND attempt_id = ?", ("v1", "a1")
        )
        assert rows[0]["checksum"] == "deadbeef"


class TestCompletionReplay:
    def test_a_recorded_completion_is_replayed_until_acknowledged(self, journal):
        journal.start_job("v1", "a1", job_id="j1")
        journal.record_completion("v1", "a1", {"status": "success", "video_id": "v1"})
        pending = journal.unacknowledged_completions()
        assert len(pending) == 1
        assert pending[0]["payload"]["status"] == "success"

        journal.acknowledge_completion("v1", "a1")
        assert journal.unacknowledged_completions() == []

    def test_a_corrupt_payload_is_skipped_rather_than_crashing_replay(self, journal):
        journal.start_job("v1", "a1")
        journal._execute(
            "INSERT INTO completion (video_id, attempt_id, payload, acknowledged, created_at, updated_at)"
            " VALUES (?, ?, ?, 0, ?, ?)",
            ("v1", "a1", "{not json", time.time(), time.time()),
        )
        assert journal.unacknowledged_completions() == []

    def test_snapshot_path_is_returned_only_while_it_exists(self, journal, tmp_path):
        snapshot = tmp_path / "snap.mp4"
        snapshot.write_bytes(b"x")
        journal.start_job("v1", "a1", snapshot_path=str(snapshot))
        assert journal.fetch_snapshot_path("v1", "a1") == snapshot
        snapshot.unlink()
        assert journal.fetch_snapshot_path("v1", "a1") is None


class TestJournalDurability:
    def test_records_survive_reopening_the_database(self, tmp_path):
        path = tmp_path / "journal.sqlite"
        first = RecoveryJournal(path)
        first.start_job("v1", "a1", job_id="j1", source_sha256="abc")
        first.record_rendition("v1", "a1", "720p", str(tmp_path / "x.mp4"))
        first.close()

        second = RecoveryJournal(path)
        reopened = second.get_job("v1", "a1")
        assert reopened is not None
        assert reopened.job_id == "j1"
        assert reopened.source_sha256 == "abc"
        second.close()


class TestConfigFromEnv:
    def test_defaults_target_a_local_api_with_no_credentials(self):
        config = AgentConfig.from_env({})
        assert config.api_url == "http://localhost:8787"
        assert config.secret == ""
        assert config.capacity_jobs == 1
        assert config.capacity_renditions == 1

    def test_reads_named_roots(self):
        config = AgentConfig.from_env({"CLIPMUX_ROOTS": "media:/srv/media,archive:/mnt/a"})
        assert [(root.name, str(root.path)) for root in config.roots] == [
            ("media", "/srv/media"),
            ("archive", "/mnt/a"),
        ]

    def test_a_root_without_a_name_derives_one(self):
        config = AgentConfig.from_env({"CLIPMUX_ROOTS": "/srv/media"})
        assert config.roots[0].name == "media"

    def test_reads_a_roots_file_when_no_roots_env_is_set(self, tmp_path):
        roots_file = tmp_path / "roots.json"
        roots_file.write_text('{"roots": [{"name": "media", "path": "/srv/media"}]}')
        config = AgentConfig.from_env({"CLIPMUX_ROOTS_FILE": str(roots_file)})
        assert [root.name for root in config.roots] == ["media"]

    def test_a_malformed_roots_file_is_ignored_not_fatal(self, tmp_path):
        roots_file = tmp_path / "roots.json"
        roots_file.write_text("{not json")
        config = AgentConfig.from_env({"CLIPMUX_ROOTS_FILE": str(roots_file)})
        assert config.roots == []

    def test_invalid_numbers_fall_back_to_defaults(self):
        config = AgentConfig.from_env({"CLIPMUX_CAPACITY_JOBS": "lots", "CLIPMUX_HEARTBEAT_SECONDS": "-5"})
        assert config.capacity_jobs == 1
        assert config.heartbeat_seconds == 30.0

    def test_progress_beats_default_to_one_per_fifteen_seconds(self):
        config = AgentConfig.from_env({})
        assert config.progress_beat_seconds == 15.0

    def test_progress_beat_cadence_is_tunable(self):
        config = AgentConfig.from_env({"CLIPMUX_PROGRESS_BEAT_SECONDS": "45"})
        assert config.progress_beat_seconds == 45.0

    def test_an_invalid_progress_beat_cadence_falls_back(self):
        # Zero or negative would send every update — the flood this setting exists
        # to prevent — so it falls back like the other numeric settings.
        config = AgentConfig.from_env({"CLIPMUX_PROGRESS_BEAT_SECONDS": "0"})
        assert config.progress_beat_seconds == 15.0

    def test_validation_reports_every_missing_precondition(self, tmp_path):
        config = AgentConfig.from_env({"CLIPMUX_SCRATCH_DIR": str(tmp_path)})
        problems = config.validate()
        assert any("LOCAL_TRANSCODER_SECRET" in problem for problem in problems)
        assert any("folders" in problem for problem in problems)

    def test_validation_reports_a_missing_folder(self, tmp_path):
        config = AgentConfig.from_env(
            {
                "CLIPMUX_ROOTS": f"media:{tmp_path / 'not-here'}",
                "LOCAL_TRANSCODER_SECRET": "s" * 32,
            }
        )
        assert any("does not exist" in problem for problem in config.validate())

    def test_validation_passes_for_a_complete_configuration(self, tmp_path):
        config = AgentConfig.from_env(
            {
                "CLIPMUX_ROOTS": f"media:{tmp_path}",
                "LOCAL_TRANSCODER_SECRET": "s" * 32,
                "CLIPMUX_API_URL": "https://api.example.com",
            }
        )
        assert config.validate() == []


class TestErrorMapping:
    def test_an_unauthorized_response_is_terminal(self):
        error = _error_for(401, "Invalid credential", "", None)
        assert isinstance(error, AuthenticationFailed)
        assert error.retryable is False

    def test_a_forbidden_response_is_terminal(self):
        assert isinstance(_error_for(403, "disabled", "AGENT_DISABLED", None), AuthenticationFailed)

    def test_a_superseded_conflict_stops_the_attempt(self):
        error = _error_for(409, "Attempt is no longer current", "SUPERSEDED", None)
        assert isinstance(error, LeaseLost)

    def test_an_unverified_inventory_conflict_is_recoverable(self):
        # The runner resolves this by verifying, so it must not be treated as a
        # lost lease.
        error = _error_for(409, "not verified", "INVENTORY_UNVERIFIED", None)
        assert not isinstance(error, LeaseLost)
        assert error.code == "INVENTORY_UNVERIFIED"

    def test_server_errors_are_retryable(self):
        assert _error_for(500, "boom", "", None).retryable is True
        assert _error_for(503, "later", "", None).retryable is True

    def test_rate_limiting_is_retryable(self):
        assert _error_for(429, "slow down", "", None).retryable is True

    def test_a_client_error_is_not_retryable(self):
        assert _error_for(400, "bad request", "", None).retryable is False

    def test_lease_lost_carries_the_server_message(self):
        error = _error_for(409, "Attempt is no longer current", "SUPERSEDED", None)
        assert isinstance(error, LeaseLost)
        assert "no longer current" in str(error)


class TestDefaultApiConfig:
    def test_timeouts_are_bounded_so_a_hung_server_cannot_wedge_the_agent(self):
        from clipmux_transcoder.agent.client import ApiConfig

        config = ApiConfig(base_url="https://api.example.com", secret="s" * 32)
        assert config.timeout > 0
        assert config.attempts >= 1

    def test_the_client_sends_the_deployment_secret_header(self):
        from clipmux_transcoder.agent.client import ApiConfig, TranscoderApiClient

        client = TranscoderApiClient(ApiConfig(base_url="https://api.example.com", secret="secret"))
        assert client.session.headers["x-local-transcoder-secret"] == "secret"
        assert client._url("poll") == "https://api.example.com/api/transcoder/v1/poll"


class TestRunnerIsSideEffectFreeAtImport:
    def test_importing_the_runner_does_not_open_the_journal_or_network(self):
        # `doctor` and `version` must work on a machine with no state directory.
        import importlib

        import clipmux_transcoder.agent.runner as runner

        importlib.reload(runner)
        assert hasattr(runner, "JobRunner")


class TestRenditionReuseAcrossAttempts:
    """
    A retry gets a fresh attempt id from the server.

    Keying reuse on the attempt id therefore made the journal's contents
    unreachable exactly when they were needed — the resume path existed and had
    no working caller. Reuse is bound to what determines the bytes: the source
    hash and the plan fingerprint.
    """

    def test_a_new_attempt_reuses_the_previous_attempts_renditions(self, journal, tmp_path):
        output = tmp_path / "renditions" / "720p.mp4"
        output.parent.mkdir(parents=True)
        output.write_bytes(b"x" * 5000)

        journal.start_job("v1", "att-1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "att-1", "720p", str(output))

        # The retry: same video, same source, same plan, different attempt id.
        journal.start_job("v1", "att-2", source_sha256="abc", plan_fingerprint="plan-1")
        reusable = journal.reusable_across_attempts("v1", "abc", "plan-1")
        assert reusable == {"720p": str(output)}

    def test_a_changed_source_blocks_reuse_across_attempts(self, journal, tmp_path):
        output = tmp_path / "720p.mp4"
        output.write_bytes(b"x" * 5000)
        journal.start_job("v1", "att-1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "att-1", "720p", str(output))

        assert journal.reusable_across_attempts("v1", "different", "plan-1") == {}

    def test_a_changed_plan_blocks_reuse_across_attempts(self, journal, tmp_path):
        output = tmp_path / "720p.mp4"
        output.write_bytes(b"x" * 5000)
        journal.start_job("v1", "att-1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "att-1", "720p", str(output))

        assert journal.reusable_across_attempts("v1", "abc", "plan-2") == {}

    def test_another_video_never_reuses_this_one(self, journal, tmp_path):
        output = tmp_path / "720p.mp4"
        output.write_bytes(b"x" * 5000)
        journal.start_job("v1", "att-1", source_sha256="abc", plan_fingerprint="plan-1")
        journal.record_rendition("v1", "att-1", "720p", str(output))

        assert journal.reusable_across_attempts("v2", "abc", "plan-1") == {}


class TestWorkerCliSurface:
    def test_fleet_management_commands_are_not_available(self):
        from clipmux_transcoder.agent.cli import build_parser

        parser = build_parser()
        for command in ("pair", "jobs", "retry", "cancel", "rotate-token"):
            try:
                parser.parse_args([command])
            except SystemExit as exc:
                assert exc.code == 2
            else:
                raise AssertionError(f"obsolete command {command!r} was accepted")

    def test_doctor_status_does_not_require_or_create_persistent_identity(self, tmp_path, monkeypatch):
        monkeypatch.setenv("CLIPMUX_STATE_DIR", str(tmp_path))
        from clipmux_transcoder.agent.cli import load_config
        from clipmux_transcoder.agent.config import AgentConfig

        config = AgentConfig.from_env({"LOCAL_TRANSCODER_SECRET": "s" * 32})
        assert config.secret == "s" * 32
        assert not (tmp_path / "token").exists()
        assert load_config(type("Args", (), {"api": None, "scratch_dir": None, "root": None})()).secret == ""
