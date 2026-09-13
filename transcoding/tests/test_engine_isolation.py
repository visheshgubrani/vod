"""
The engine must import and run with none of the optional extras installed.

This is the acceptance gate for the engine extraction ("package imports without
Modal"), and it is worth a subprocess rather than an assertion about
`sys.modules`: a blocked import can be *deferred* into a function and still
break a real agent. Running the check in a clean interpreter with the optional
packages hidden is the only version of it that can fail for the right reason.
"""
import subprocess
import sys
import textwrap
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent

# Modules that must not be needed to import, plan or inspect the engine.
# `requests` is deliberately absent from this list: it is a hard dependency of
# the agent's HTTP client, and it is present on every supported install.
OPTIONAL_MODULES = ("modal", "boto3", "botocore", "faster_whisper", "torch", "groq")


def run_python(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        cwd=str(PACKAGE_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )


class TestImportIsolation:
    def test_importing_the_package_does_not_import_optional_extras(self):
        completed = run_python(f"""
            import sys
            import openvod_transcoder
            banned = [m for m in {OPTIONAL_MODULES!r} if m in sys.modules]
            assert banned == [], f"engine pulled in optional modules: {{banned}}"
            print("ok")
        """)
        assert completed.returncode == 0, completed.stderr
        assert "ok" in completed.stdout

    def test_importing_the_pipeline_module_stays_clean(self):
        completed = run_python(f"""
            import sys
            import openvod_transcoder.pipeline  # noqa: F401
            banned = [m for m in {OPTIONAL_MODULES!r} if m in sys.modules]
            assert banned == [], f"pipeline pulled in optional modules: {{banned}}"
            print("ok")
        """)
        assert completed.returncode == 0, completed.stderr

    def test_optional_modules_can_be_made_unimportable_entirely(self):
        """
        Simulate a bare machine: block the optional imports outright, then
        import, plan, and build an FFmpeg command.
        """
        completed = run_python(f"""
            import sys

            class Blocker:
                def find_module(self, name, path=None):
                    if name.split(".")[0] in {OPTIONAL_MODULES!r}:
                        return self
                    return None
                def load_module(self, name):
                    raise ImportError(f"{{name}} is not installed on this machine")

            sys.meta_path.insert(0, Blocker())

            from openvod_transcoder import ProcessingOptions, plan_renditions
            from openvod_transcoder.encoding.backends import (
                CPU_BACKEND, RenderSpec, build_video_command,
            )
            from openvod_transcoder.video.analysis import VideoMetadata

            metadata = VideoMetadata(
                width=1920, height=1080, duration=60.0, fps=30.0,
                has_audio=True, has_video=True, is_hdr=False, codec_name="h264",
            )
            specs = plan_renditions(metadata)
            assert [s.height for s in specs] == [1080, 720, 480, 360]

            cmd = build_video_command(
                ffmpeg="ffmpeg", input_path="/in.mp4", output_path="/out.mp4",
                backend=CPU_BACKEND, spec=specs[0], metadata=metadata,
                segment_duration=4.0, gpu_decode=False,
            )
            assert "libx264" in cmd
            assert ProcessingOptions().plan_fingerprint()
            print("ok")
        """)
        assert completed.returncode == 0, completed.stderr

    def test_probing_without_ffmpeg_installed_reports_rather_than_raises(self):
        completed = run_python("""
            from openvod_transcoder.encoding.probe import (
                probe_backend, synthetic_command,
            )
            from openvod_transcoder.encoding.backends import CPU_BACKEND

            def runner(cmd, **kwargs):
                raise FileNotFoundError("ffmpeg")

            probe = probe_backend(CPU_BACKEND, run=runner)
            assert probe.available is False
            assert "not found" in probe.reason
            print("ok")
        """)
        assert completed.returncode == 0, completed.stderr

    def test_transfer_backends_are_not_imported_eagerly(self):
        completed = run_python(f"""
            import sys
            import openvod_transcoder.transfer  # noqa: F401
            banned = [m for m in {OPTIONAL_MODULES!r} if m in sys.modules]
            assert banned == [], f"transfer package pulled in: {{banned}}"
            print("ok")
        """)
        assert completed.returncode == 0, completed.stderr


class TestConfigurationSurface:
    def test_config_module_has_no_storage_credentials_at_import(self):
        completed = run_python("""
            import openvod_transcoder.config as config
            # The engine's config is policy, not credentials: S3 client config
            # lives in the transfer backend that actually needs it.
            assert not hasattr(config, "S3_CONFIG")
            assert not hasattr(config, "TRANSFER_CONFIG")
            assert config.PROCESSING_PLAN_VERSION >= 1
            assert config.DEFAULT_MAX_HEIGHT == 1080
            print("ok")
        """)
        assert completed.returncode == 0, completed.stderr


class TestContractFixtures:
    """
    The Python engine and the TypeScript finalizer meet at a JSON payload, and
    nothing type-checks that seam.

    The Modal playback-URL regression lived exactly there: the engine started
    returning output-relative paths, the API kept assuming complete object keys,
    and every new Modal video got a URL that 404s. So the fixtures are generated
    from the real engine and consumed by `server/tests/lib/completionContract`,
    with this test failing if they ever drift.
    """

    def test_committed_fixtures_match_what_the_engine_produces_now(self):
        import json
        import sys

        sys.path.insert(0, str(PACKAGE_ROOT / "tests"))
        from contract_fixtures import fixtures  # type: ignore[import-not-found]

        committed = json.loads(
            (PACKAGE_ROOT / "tests" / "fixtures" / "completion_payloads.json").read_text()
        )
        assert committed == fixtures(), (
            "completion payload fixtures are stale — regenerate with "
            "`python -m tests.contract_fixtures` from transcoding/"
        )

    def test_modal_and_agent_payloads_differ_only_by_the_key_prefix(self):
        import sys

        sys.path.insert(0, str(PACKAGE_ROOT / "tests"))
        from contract_fixtures import fixtures  # type: ignore[import-not-found]

        payloads = fixtures()
        modal = payloads["modal"]["outputs"]
        agent = payloads["agent"]["outputs"]
        prefix = f"{payloads['meta']['r2Prefix']}/{payloads['meta']['videoId']}"

        for key in ("hls_playlist", "dash_manifest", "poster", "subtitles"):
            assert agent[key] is not None, f"{key} missing from the agent payload"
            assert modal[key] == f"{prefix}/{agent[key]}", key
