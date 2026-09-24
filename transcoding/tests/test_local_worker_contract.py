"""The local worker heartbeat is a cross-language API contract."""
import json
from pathlib import Path

from clipmux_transcoder.agent.client import ApiConfig, TranscoderApiClient
from clipmux_transcoder.encoding.probe import CapabilityReport, EncoderProbe


CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "local-worker-heartbeat.json").read_text()
)


def test_python_heartbeat_matches_the_server_contract(monkeypatch):
    report = CapabilityReport(
        ffmpeg="7.1",
        shaka="1.7",
        compiled_hwaccels=["cuda"],
        encoders={
            "cpu": EncoderProbe(backend="cpu", available=True),
            "nvenc": EncoderProbe(backend="nvenc", available=True),
        },
        cpu_cores=8,
        memory_bytes=17179869184,
        scratch_free_bytes=107374182400,
        detected_at=1790208000,
    )
    assert report.to_payload() == CONTRACT["capabilities"]

    client = TranscoderApiClient(ApiConfig(base_url="https://api.example.com", secret="s" * 32))
    sent = {}
    monkeypatch.setattr(
        client,
        "_request",
        lambda method, path, *, json_body: sent.update(json_body) or {"ok": True},
    )

    client.heartbeat(
        capabilities=report.to_payload(),
        hostname=CONTRACT["hostname"],
        worker_version=CONTRACT["workerVersion"],
        capacity_jobs=CONTRACT["capacityJobs"],
        capacity_renditions=CONTRACT["capacityRenditions"],
    )

    assert sent == CONTRACT


def test_daemon_sends_operator_configured_capacity_and_server_field_names(tmp_path):
    from clipmux_transcoder import __version__
    from clipmux_transcoder.agent.config import AgentConfig
    from clipmux_transcoder.agent.daemon import TranscoderAgent
    from clipmux_transcoder.agent.journal import RecoveryJournal
    from clipmux_transcoder.encoding.probe import CapabilityReport
    from clipmux_transcoder.paths import Root

    media = tmp_path / "media"
    media.mkdir()
    config = AgentConfig(
        api_url="https://api.example.com",
        secret="s" * 32,
        roots=[Root(name="media", path=media)],
        scratch_dir=tmp_path / "scratch",
        journal_path=tmp_path / "journal.sqlite",
        capacity_jobs=3,
        capacity_renditions=2,
    )

    class Client:
        calls = []

        def heartbeat(self, **kwargs):
            self.calls.append(kwargs)
            return {"ok": True}

    class OneBeat:
        waits = 0

        def wait(self, _seconds):
            self.waits += 1
            return self.waits > 1

    client = Client()
    journal = RecoveryJournal(config.journal_path)
    agent = TranscoderAgent(
        config,
        client,
        journal,
        capabilities=CapabilityReport(),
        verbose=False,
    )
    agent._stop = OneBeat()
    agent._cleanup = lambda: None
    try:
        agent._heartbeat_loop()
    finally:
        journal.close()

    beat = client.calls[0]
    assert beat["capacity_jobs"] == 3
    assert beat["capacity_renditions"] == 2
    assert beat["worker_version"] == __version__
    assert "agent_version" not in beat
