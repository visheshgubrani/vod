"""
The self-hosted transcoding agent.

`openvod_transcoder.agent` is the *execution* half of the shared engine: it owns
the machine, the credential, the queue participation and the local recovery cache.
It deliberately does not own the encoding pipeline — that is
:mod:`openvod_transcoder.pipeline`, shared byte-for-byte with the Modal runner.

Importing this package must stay cheap and dependency-light: `requests` is needed
only when a client is constructed, and nothing here may import Modal, boto3 or
Whisper. `openvod-transcoder doctor` runs on a machine where none of them exist.
"""

__all__ = ["AgentConfig", "JobRunner", "RecoveryJournal", "TranscoderApiClient", "main"]


def __getattr__(name: str):
    """
    Lazy re-exports.

    Deferred so `openvod-transcoder version` does not pay for the HTTP client, the
    journal's SQLite handle or the pipeline's imports. The CLI is the entry point
    on a machine that may only be running `doctor`, and a slow or failing import
    there is the worst possible first impression.
    """
    if name == "AgentConfig":
        from openvod_transcoder.agent.config import AgentConfig

        return AgentConfig
    if name == "RecoveryJournal":
        from openvod_transcoder.agent.journal import RecoveryJournal

        return RecoveryJournal
    if name == "TranscoderApiClient":
        from openvod_transcoder.agent.client import TranscoderApiClient

        return TranscoderApiClient
    if name == "JobRunner":
        from openvod_transcoder.agent.runner import JobRunner

        return JobRunner
    if name == "main":
        from openvod_transcoder.agent.cli import main

        return main
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
