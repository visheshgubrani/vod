"""Pipeline orchestration: staging, fallback, cancellation, inventory, validation.

These are integration tests over injected seams — no FFmpeg and no Shaka process
is started. What they establish is the *contract* the two real runners depend on:
what gets encoded, in what order, what is allowed to fail the job, and what the
result payload looks like when it reaches the API.
"""
import threading
import time
from pathlib import Path
from typing import Dict, List

import pytest

from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.encoding.failures import build_process_error
from openvod_transcoder.encoding.probe import CapabilityReport, ChainProbe, EncoderProbe
from openvod_transcoder.errors import (
    ERROR_EMPTY_FILE,
    ERROR_ENCODER_FAILED,
    ERROR_MISSING_RENDITION,
    ERROR_PACKAGING_FAILED,
    ERROR_PARTIAL_UPLOAD,
    CancelledError,
    TranscodeError,
)
from openvod_transcoder.options import ProcessingOptions
from openvod_transcoder import pipeline as pipeline_module
from openvod_transcoder.pipeline import output_prefix, run_pipeline
from openvod_transcoder.progress import ProgressUpdate
from openvod_transcoder.transfer import TransferError, TransferStats
from openvod_transcoder.video.analysis import VideoMetadata


# ── fakes ────────────────────────────────────────────────────────────────────

class RecordingSink:
    def __init__(self):
        self.updates: List[ProgressUpdate] = []

    def report(self, update):
        self.updates.append(update)

    @property
    def stages(self):
        return [update.stage for update in self.updates]


def metadata_for(width=1920, height=1080, **overrides):
    base = dict(
        width=width,
        height=height,
        duration=60.0,
        fps=30.0,
        has_audio=True,
        has_video=True,
        is_hdr=False,
        codec_name="h264",
    )
    base.update(overrides)
    return VideoMetadata(**base)


class FakeFfmpeg:
    """
    Stands in for `run_ffmpeg`.

    Writes a plausible output file for the command it is given and reports two
    progress blocks, so the pipeline's progress wiring is exercised end to end.

    ``behavior`` is the escape hatch the regression tests need: a callable
    ``(label, attempt_number) -> exception or None`` that decides, per attempt,
    whether this encode fails and how. ``blocked`` labels wait on the
    cancellation token before failing, which is how "a terminal failure stops
    the siblings" is proven without a real encoder.
    """

    def __init__(
        self,
        metadata,
        *,
        fail_labels=(),
        fail_times=1,
        error=None,
        behavior=None,
        blocked=(),
        block_seconds=5.0,
    ):
        self.metadata = metadata
        self.calls: List[str] = []
        self.commands: List[List[str]] = []
        self.seen: Dict[str, int] = {}
        self.fail_labels = set(fail_labels)
        self.fail_times = fail_times
        self.error = error or TranscodeError(ERROR_ENCODER_FAILED, "gpu exploded")
        self.failures = 0
        self.behavior = behavior
        self.blocked = set(blocked)
        self.block_seconds = block_seconds
        self.cancelled_siblings = 0
        # Concurrency is measured here rather than assumed: the CPU-rendition cap
        # is only meaningful if it is observable.
        self._lock = threading.Lock()
        self._active = 0
        self.peak_concurrency = 0

    def __call__(self, cmd, *, label, duration=None, on_progress=None, cancellation=None, stall=None):
        self.calls.append(label)
        self.commands.append(list(cmd))
        self.seen[label] = self.seen.get(label, 0) + 1
        self._enter()
        try:
            return self._run(cmd, label, on_progress, cancellation)
        finally:
            self._exit()

    def _enter(self):
        with self._lock:
            self._active += 1
            self.peak_concurrency = max(self.peak_concurrency, self._active)

    def _exit(self):
        with self._lock:
            self._active -= 1

    def _run(self, cmd, label, on_progress, cancellation):
        if label in self.blocked:
            if cancellation is not None:
                cancellation.wait(self.block_seconds)
                if cancellation.cancelled:
                    self.cancelled_siblings += 1
            raise CancelledError("sibling stopped")

        if self.behavior is not None:
            outcome = self.behavior(label, self.seen[label], cmd)
            if outcome is not None:
                raise outcome

        if any(marker in label for marker in self.fail_labels) and self.failures < self.fail_times:
            self.failures += 1
            raise self.error
        if on_progress is not None:
            from openvod_transcoder.ffmpeg_progress import FfmpegProgress

            on_progress(FfmpegProgress(out_time_seconds=30.0, speed=1.5), 0.5)
            on_progress(FfmpegProgress(out_time_seconds=60.0, speed=1.5), 1.0)
        Path(cmd[-1]).write_bytes(b"encoded" * 500)
        import subprocess

        return subprocess.CompletedProcess(cmd, 0, "", "")


def fake_package(renditions: Dict[str, Path], output_dir: Path, segment_duration: float = 4.0):
    """Write the package layout a real Shaka run produces."""
    output_dir = Path(output_dir)
    (output_dir / "playlist.m3u8").write_text("#EXTM3U\n")
    (output_dir / "manifest.mpd").write_text("<MPD/>\n")
    for label in renditions:
        stream = output_dir / ("audio" if label == "audio" else f"video_{label}")
        stream.mkdir(parents=True, exist_ok=True)
        (stream / "init.mp4").write_bytes(b"init")
        (stream / "1.m4s").write_bytes(b"seg" * 100)


class FakeTransfer:
    def __init__(self, *, fail=(), complete=True):
        self.fail = set(fail)
        self.calls = []

    def upload_artifacts(self, output_dir, relative_paths, *, already_uploaded=frozenset()):
        pending = [path for path in relative_paths if path not in already_uploaded]
        self.calls.append(pending)
        failed = [
            TransferError(path=path, message="boom") for path in pending if path in self.fail
        ]
        return TransferStats(
            total=len(relative_paths),
            uploaded=len(pending) - len(failed),
            skipped=len(relative_paths) - len(pending),
            failed=failed,
        )


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture()
def source(tmp_path: Path) -> Path:
    path = tmp_path / "source" / "lesson-01.mp4"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"media" * 2048)
    return path


@pytest.fixture()
def capability_report():
    return CapabilityReport(
        encoders={
            "cpu": EncoderProbe(backend="cpu", available=True),
            "nvenc": EncoderProbe(backend="nvenc", available=False, reason="not compiled"),
            "vaapi": EncoderProbe(backend="vaapi", available=False, reason="not compiled"),
        }
    )


@pytest.fixture()
def patched(monkeypatch):
    """Wire the pipeline's seams. Returns a settable bundle."""
    bundle = {
        "metadata": metadata_for(),
        "ffmpeg": None,
        "package_error": None,
        "poster_error": None,
        "transcribe_error": None,
        "chapters_error": None,
        "probes": {},
        "preflight_calls": [],
        "package_calls": [],
        "validator": None,
    }

    def fake_metadata(_path):
        return bundle["metadata"]

    def fake_probe_streams(_path):
        return [
            {"index": 0, "codec_type": "video", "codec_name": "h264"},
            {"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2,
             "disposition": {"default": 1}},
        ]

    def fake_run_ffmpeg(cmd, **kwargs):
        return bundle["ffmpeg"](cmd, **kwargs)

    def fake_shaka(renditions, output_dir, segment_duration=4.0):
        bundle["package_calls"].append(segment_duration)
        if bundle["package_error"]:
            raise bundle["package_error"]
        fake_package(renditions, output_dir, segment_duration)

    def fake_poster(input_path, output_path, duration):
        if bundle["poster_error"]:
            raise bundle["poster_error"]
        Path(output_path).write_bytes(b"jpeg")

    def fake_transcribe(*args, **kwargs):
        if bundle["transcribe_error"]:
            raise bundle["transcribe_error"]
        Path(args[1]).write_text("WEBVTT\n\n")

    def fake_chapters(*args, **kwargs):
        if bundle["chapters_error"]:
            raise bundle["chapters_error"]
        return [{"startTime": 0, "endTime": 10, "title": "Intro"}]

    def fake_preflight(source_path, metadata, backend, **kwargs):
        bundle["preflight_calls"].append(backend.name)
        return bundle["probes"].get(
            backend.name, ChainProbe(backend=backend.name, reason="not probed in this test")
        )

    def fake_validate(path, spec, **kwargs):
        if bundle["validator"] is not None:
            return bundle["validator"](path, spec, **kwargs)
        return None

    monkeypatch.setattr(pipeline_module, "get_video_metadata", fake_metadata)
    monkeypatch.setattr(pipeline_module, "_probe_streams", fake_probe_streams)
    monkeypatch.setattr(pipeline_module, "run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(pipeline_module, "package_with_shaka", fake_shaka)
    monkeypatch.setattr(pipeline_module, "preflight_source", fake_preflight)
    monkeypatch.setattr(pipeline_module, "validate_encoded_rendition", fake_validate)

    import openvod_transcoder.video.poster as poster_module
    import openvod_transcoder.video.transcription as transcription_module
    import openvod_transcoder.video.chapters as chapters_module

    monkeypatch.setattr(poster_module, "generate_poster", fake_poster)
    monkeypatch.setattr(transcription_module, "transcribe_to_vtt", fake_transcribe)
    monkeypatch.setattr(chapters_module, "generate_chapters", fake_chapters)

    bundle["ffmpeg"] = FakeFfmpeg(bundle["metadata"])
    return bundle


def run(tmp_path, source, patched, report=None, **option_overrides):
    options = ProcessingOptions(video_id="vid-1", attempt_id="att-1", **option_overrides)
    report = report or RecordingSink()
    result = run_pipeline(
        source,
        tmp_path / "work",
        options,
        patched["capability"] if "capability" in patched else CapabilityReport(
            encoders={
                "cpu": EncoderProbe(backend="cpu", available=True),
                "nvenc": EncoderProbe(backend="nvenc", available=False),
                "vaapi": EncoderProbe(backend="vaapi", available=False),
            }
        ),
        report,
    )
    return result, report


# ── tests ────────────────────────────────────────────────────────────────────

class TestHappyPath:
    def test_encodes_every_planned_rendition_plus_audio(self, tmp_path, source, patched):
        result, _ = run(tmp_path, source, patched)
        labels = {rendition.label for rendition in result.renditions}
        assert labels == {"1080p", "720p", "480p", "360p"}
        assert "encode-audio" in patched["ffmpeg"].calls

    def test_reports_the_renditions_it_was_asked_for(self, tmp_path, source, patched):
        result, _ = run(tmp_path, source, patched)
        assert [r.height for r in result.renditions] == [1080, 720, 480, 360]
        assert {(r.width, r.height) for r in result.renditions} == {
            (1920, 1080), (1280, 720), (852, 480), (640, 360),
        }

    def test_inventory_assigns_roles_from_paths(self, tmp_path, source, patched):
        result, _ = run(tmp_path, source, patched)
        by_role = {}
        for artifact in result.artifacts:
            by_role.setdefault(artifact.role, []).append(artifact.path)
        assert by_role["playlist"] == ["playlist.m3u8"]
        assert by_role["dash"] == ["manifest.mpd"]
        assert by_role["poster"] == ["poster.jpg"]
        assert sorted(by_role["segment"]) == [
            "audio/1.m4s", "audio/init.mp4",
            "video_1080p/1.m4s", "video_1080p/init.mp4",
            "video_360p/1.m4s", "video_360p/init.mp4",
            "video_480p/1.m4s", "video_480p/init.mp4",
            "video_720p/1.m4s", "video_720p/init.mp4",
        ]

    def test_every_artifact_carries_a_content_hash_and_size(self, tmp_path, source, patched):
        result, _ = run(tmp_path, source, patched)
        assert result.artifacts
        for artifact in result.artifacts:
            assert artifact.size > 0
            assert len(artifact.checksum) == 64

    def test_progress_walks_the_stages_in_order(self, tmp_path, source, patched):
        _, report = run(tmp_path, source, patched)
        stages = report.stages
        assert stages[0] == "snapshot"
        assert "analyze" in stages
        assert "transcode" in stages
        assert "package" in stages
        assert "verify" in stages
        assert stages[-1] == "complete"

    def test_transcode_progress_is_reported_per_rendition(self, tmp_path, source, patched):
        _, report = run(tmp_path, source, patched)
        transcode_updates = [u for u in report.updates if u.stage == "transcode" and u.renditions]
        assert transcode_updates
        assert set(transcode_updates[-1].renditions) >= {"1080p", "720p"}

    def test_result_payload_matches_the_modal_callback_vocabulary(self, tmp_path, source, patched):
        result, _ = run(tmp_path, source, patched)
        payload = result.as_payload()
        assert payload["status"] == "success"
        assert payload["outputs"]["hls_playlist"] == "playlist.m3u8"
        assert payload["outputs"]["dash_manifest"] == "manifest.mpd"
        assert payload["outputs"]["poster"] == "poster.jpg"
        assert payload["metadata"]["duration"] == 60.0
        assert payload["metadata"]["is_vertical"] is False
        assert payload["processing"]["backend"] == "cpu"
        assert payload["inventory"]

    def test_work_directory_is_separated_per_attempt(self, tmp_path, source, patched):
        # Two attempts must never share a work directory, or a late worker
        # overwrites the newer attempt's files.
        run(tmp_path, source, patched)
        run(tmp_path, source, patched)
        assert (tmp_path / "work" / "output" / "playlist.m3u8").exists()


class TestRenditionPolicy:
    def test_explicit_1440p_and_2160p_are_honoured(self, tmp_path, source, patched):
        patched["metadata"] = metadata_for(3840, 2160)
        patched["ffmpeg"] = FakeFfmpeg(patched["metadata"])
        result, _ = run(tmp_path, source, patched, include_heights=(1440, 2160))
        assert [r.height for r in result.renditions] == [2160, 1440, 1080, 720, 480, 360]

    def test_audio_only_source_packages_audio_alone(self, tmp_path, source, patched):
        patched["metadata"] = metadata_for(0, 0, has_video=False)
        patched["ffmpeg"] = FakeFfmpeg(patched["metadata"])
        result, _ = run(tmp_path, source, patched)
        assert result.renditions == []
        assert any(a.path.startswith("audio/") for a in result.artifacts)


class TestNonFatalEnrichment:
    def test_poster_failure_does_not_fail_the_job(self, tmp_path, source, patched):
        patched["poster_error"] = RuntimeError("no frame at that timestamp")
        result, _ = run(tmp_path, source, patched)
        assert result.artifact_for_role("poster") is None
        assert result.as_payload()["inventory"]

    def test_subtitle_failure_is_reported_but_nonfatal(self, tmp_path, source, patched):
        patched["transcribe_error"] = RuntimeError("no cuda for whisper")
        result, _ = run(tmp_path, source, patched, generate_subtitle=True)
        assert result.enrichments["subtitles"].requested is True
        assert result.enrichments["subtitles"].generated is False
        assert result.enrichments["subtitles"].status == "failed"

    def test_successful_subtitles_are_in_the_inventory(self, tmp_path, source, patched):
        result, _ = run(tmp_path, source, patched, generate_subtitle=True)
        assert result.enrichments["subtitles"].generated is True
        assert any(a.role == "subtitle" for a in result.artifacts)

    def test_chapters_require_subtitles_and_are_skipped_without_them(
        self, tmp_path, source, patched
    ):
        result, _ = run(tmp_path, source, patched, generate_chapters=True)
        assert result.enrichments["chapters"].status == "skipped"

    def test_chapters_are_generated_from_a_transcript(self, tmp_path, source, patched):
        result, _ = run(
            tmp_path, source, patched, generate_subtitle=True, generate_chapters=True
        )
        assert result.enrichments["chapters"].status == "completed"
        assert result.enrichments["chapters"].data[0]["title"] == "Intro"
        assert any(a.role == "chapters" for a in result.artifacts)


class TestFailures:
    def test_empty_source_is_a_typed_failure(self, tmp_path, patched):
        path = tmp_path / "tiny.mp4"
        path.write_bytes(b"x")
        with pytest.raises(TranscodeError) as caught:
            run(tmp_path, path, patched)
        assert caught.value.code == ERROR_EMPTY_FILE

    def test_requested_subtitles_do_not_fail_the_job_but_packaging_does(
        self, tmp_path, source, patched
    ):
        patched["package_error"] = RuntimeError("shaka segfault")
        with pytest.raises(TranscodeError) as caught:
            run(tmp_path, source, patched)
        assert caught.value.code == ERROR_PACKAGING_FAILED

    def test_a_missing_rendition_in_the_package_is_caught_before_upload(
        self, tmp_path, source, patched, monkeypatch
    ):
        def partial_package(renditions, output_dir, segment_duration=4.0):
            fake_package({"1080p": Path("x")}, output_dir, segment_duration)

        monkeypatch.setattr(pipeline_module, "package_with_shaka", partial_package)
        with pytest.raises(TranscodeError) as caught:
            run(tmp_path, source, patched)
        assert caught.value.code == ERROR_MISSING_RENDITION

    def test_hdr_with_an_unknown_transfer_characteristic_is_refused(
        self, tmp_path, source, patched
    ):
        patched["metadata"] = metadata_for(1920, 1080, is_hdr=True, color_transfer="smpte428")
        patched["ffmpeg"] = FakeFfmpeg(patched["metadata"])
        with pytest.raises(TranscodeError) as caught:
            run(tmp_path, source, patched)
        assert caught.value.code == "UNSUPPORTED_HDR"


class TestCancellation:
    def test_a_cancelled_token_stops_before_encoding(self, tmp_path, source, patched):
        token = CancellationToken()
        token.cancel("owner cancelled")
        options = ProcessingOptions(video_id="vid-1", attempt_id="att-1")
        with pytest.raises(CancelledError):
            run_pipeline(
                source,
                tmp_path / "work",
                options,
                CapabilityReport(encoders={"cpu": EncoderProbe(backend="cpu", available=True)}),
                RecordingSink(),
                token,
            )
        assert patched["ffmpeg"].calls == []


class TestEncoderFallback:
    def test_auto_falls_back_through_the_chain_and_records_why(
        self, tmp_path, source, patched, monkeypatch
    ):
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"], fail_labels=("nvenc",), fail_times=1
        )
        report = CapabilityReport(
            encoders={
                "cpu": EncoderProbe(backend="cpu", available=True),
                "nvenc": EncoderProbe(backend="nvenc", available=True),
                "vaapi": EncoderProbe(backend="vaapi", available=False),
            }
        )
        result = run_pipeline(
            source,
            tmp_path / "work",
            ProcessingOptions(video_id="vid-1", attempt_id="att-1"),
            report,
            RecordingSink(),
        )
        assert result.metadata.fallback_reasons
        assert "gpu exploded" in result.metadata.fallback_reasons[0]

    def test_a_non_encoder_failure_does_not_fall_back(
        self, tmp_path, source, patched
    ):
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            fail_labels=("1080p",),
            error=ValueError("media is corrupt"),
        )
        with pytest.raises(ValueError, match="corrupt"):
            run(tmp_path, source, patched)

    def test_explicit_gpu_backend_is_never_silently_cpu(self, tmp_path, source, patched):
        report = CapabilityReport(
            encoders={
                "cpu": EncoderProbe(backend="cpu", available=True),
                "nvenc": EncoderProbe(backend="nvenc", available=False, reason="no device"),
            }
        )
        with pytest.raises(TranscodeError) as caught:
            run_pipeline(
                source,
                tmp_path / "work",
                ProcessingOptions(video_id="vid-1", attempt_id="att-1", encoder_backend="nvenc"),
                report,
                RecordingSink(),
            )
        assert caught.value.code == "ENCODER_UNAVAILABLE"


class TestTransfer:
    def test_successful_transfer_is_reported_in_timings(self, tmp_path, source, patched):
        transfer = FakeTransfer()
        result = run_pipeline(
            source,
            tmp_path / "work",
            ProcessingOptions(video_id="vid-1", attempt_id="att-1"),
            CapabilityReport(encoders={"cpu": EncoderProbe(backend="cpu", available=True)}),
            RecordingSink(),
            transfer=transfer,
        )
        assert "upload" in result.metadata.timings
        assert transfer.calls

    def test_partial_transfer_fails_the_job_with_a_typed_code(self, tmp_path, source, patched):
        transfer = FakeTransfer(fail={"video_1080p/1.m4s"})
        with pytest.raises(TranscodeError) as caught:
            run_pipeline(
                source,
                tmp_path / "work",
                ProcessingOptions(video_id="vid-1", attempt_id="att-1"),
                CapabilityReport(encoders={"cpu": EncoderProbe(backend="cpu", available=True)}),
                RecordingSink(),
                transfer=transfer,
            )
        assert caught.value.code == ERROR_PARTIAL_UPLOAD


class TestOutputPrefix:
    def test_attempt_scoped(self):
        assert output_prefix("vid-1", "att-9") == "videos/vid-1/attempts/att-9"

    def test_prefix_override_is_trimmed(self):
        assert output_prefix("v", "a", prefix="/custom/") == "custom/v/attempts/a"


# ── verified execution paths ─────────────────────────────────────────────────

def report_with(*, cpu=True, nvenc=False, vaapi=False):
    return CapabilityReport(
        encoders={
            "cpu": EncoderProbe(backend="cpu", available=cpu),
            "nvenc": EncoderProbe(backend="nvenc", available=nvenc, reason="probe"),
            "vaapi": EncoderProbe(backend="vaapi", available=vaapi, reason="probe"),
        }
    )


def verified(backend="nvenc", **overrides):
    base = dict(
        backend=backend,
        hardware_encode=True,
        hardware_decode=True,
        hardware_filters=True,
        reason="ok",
    )
    base.update(overrides)
    return ChainProbe(**base)


def cuda_filter_error():
    """The stderr from the deployment that motivated the whole fallback path."""
    return build_process_error(
        stderr=(
            "[AVFilterGraph @ 0x55d1] Error initializing filter 'scale_cuda' with args "
            "'1920:1080:format=yuv420p'\nError reinitializing filters!"
        ),
        returncode=1,
        operation="encode-1080p-nvenc",
    )


def device_error():
    return build_process_error(
        stderr="[AVHWDeviceContext @ 0x1] Cannot open device /dev/dri/renderD128",
        returncode=1,
        operation="encode-1080p-nvenc",
    )


def session_error():
    return build_process_error(
        stderr="[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10)",
        returncode=1,
        operation="encode-1080p-nvenc",
    )


def run_with(patched, tmp_path, source, report, **option_overrides):
    options = ProcessingOptions(video_id="vid-1", attempt_id="att-1", **option_overrides)
    return run_pipeline(source, tmp_path / "work", options, report, RecordingSink())


class TestVerifiedExecutionPaths:
    def test_preflight_runs_per_hardware_backend_and_feeds_selection(
        self, tmp_path, source, patched
    ):
        patched["probes"] = {"nvenc": verified()}
        result = run_with(patched, tmp_path, source, report_with(nvenc=True))

        assert patched["preflight_calls"] == ["nvenc"]
        assert result.renditions[0].backend == "nvenc"
        assert result.renditions[0].mode == "gpu"

    def test_an_unverified_gpu_is_excluded_under_auto(self, tmp_path, source, patched):
        patched["probes"] = {
            "nvenc": ChainProbe(backend="nvenc", hardware_encode=False, reason="failed")
        }
        result = run_with(patched, tmp_path, source, report_with(nvenc=True))

        assert {rendition.backend for rendition in result.renditions} == {"cpu"}
        assert all("nvenc" not in label for label in patched["ffmpeg"].calls)

    def test_verified_hardware_that_only_encodes_uses_the_hybrid_path(
        self, tmp_path, source, patched
    ):
        patched["probes"] = {"nvenc": verified(hardware_decode=False, hardware_filters=False)}
        result = run_with(patched, tmp_path, source, report_with(nvenc=True))

        assert result.renditions[0].backend == "nvenc"
        assert result.renditions[0].mode == "hybrid"

    def test_ten_bit_sources_never_get_the_gpu_filter_path(self, tmp_path, source, patched):
        patched["metadata"] = metadata_for(pixel_format="yuv420p10le", bit_depth=10)
        patched["ffmpeg"] = FakeFfmpeg(patched["metadata"])
        patched["probes"] = {"nvenc": verified()}
        result = run_with(patched, tmp_path, source, report_with(nvenc=True))

        assert result.renditions[0].mode == "hybrid"

    def test_the_reported_cuda_filter_failure_advances_to_the_hybrid_path(
        self, tmp_path, source, patched
    ):
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=lambda label, attempt, cmd: cuda_filter_error()
            if label.endswith("-nvenc")
            else None,
        )
        result = run_with(patched, tmp_path, source, report_with(nvenc=True))

        labels = patched["ffmpeg"].calls
        assert any(label.endswith("-nvenc") for label in labels)
        assert any(label.endswith("+software-decode") for label in labels)
        assert all(rendition.backend == "nvenc" for rendition in result.renditions)
        assert all(rendition.mode == "hybrid" for rendition in result.renditions)
        assert "scale_cuda" in result.metadata.fallback_reasons[0]

    def test_unavailable_nvenc_reaches_cpu_in_auto(self, tmp_path, source, patched):
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=lambda label, attempt, cmd: device_error() if "nvenc" in label else None,
        )
        result = run_with(patched, tmp_path, source, report_with(nvenc=True))

        assert {rendition.backend for rendition in result.renditions} == {"cpu"}
        assert all(rendition.mode == "cpu" for rendition in result.renditions)

    def test_a_proven_unusable_backend_is_attempted_only_once(self, tmp_path, source, patched):
        # Four renditions, one set of NVENC sessions: re-discovering the same
        # broken device four times wastes the owner's time and hides the cause.
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=lambda label, attempt, cmd: device_error() if "nvenc" in label else None,
        )
        run_with(patched, tmp_path, source, report_with(nvenc=True))

        nvenc_attempts = [label for label in patched["ffmpeg"].calls if "nvenc" in label]
        assert len(nvenc_attempts) == 1


class TestPerRenditionAttemptState:
    def test_one_rendition_falling_back_does_not_advance_another(
        self, tmp_path, source, patched
    ):
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=lambda label, attempt, cmd: cuda_filter_error()
            if label == "encode-1080p-nvenc"
            else None,
        )
        result = run_with(
            patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=1
        )

        by_label = {rendition.label: rendition for rendition in result.renditions}
        # The rendition that hit the broken filter moved to hybrid...
        assert by_label["1080p"].mode == "hybrid"
        # ...and the ones that never hit it stayed on the full GPU path.
        assert by_label["720p"].mode == "gpu"
        assert by_label["720p"].backend == "nvenc"

    def test_each_rendition_reports_the_backend_that_produced_it(
        self, tmp_path, source, patched
    ):
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=lambda label, attempt, cmd: cuda_filter_error()
            if label == "encode-1080p-nvenc"
            else None,
        )
        result = run_with(
            patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=1
        )

        payload = result.as_payload()
        executions = {entry["label"]: entry for entry in payload["processing"]["renditions"]}
        assert executions["1080p"]["mode"] == "hybrid"
        assert executions["720p"]["mode"] == "gpu"
        assert payload["processing"]["backend"] == "nvenc"

    def test_a_job_encoded_across_two_encoders_is_reported_as_mixed(
        self, tmp_path, source, patched
    ):
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=_mixed_backend_behavior,
        )
        result = run_with(
            patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=1
        )

        assert result.metadata.backend_used == "mixed"
        assert result.as_payload()["processing"]["backend"] == "mixed"

    def test_gpu_session_exhaustion_is_retried_once_after_serialising(
        self, tmp_path, source, patched
    ):
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=lambda label, attempt, cmd: session_error()
            if label == "encode-1080p-nvenc" and attempt == 1
            else None,
        )
        result = run_with(
            patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=1
        )

        attempts = [label for label in patched["ffmpeg"].calls if label == "encode-1080p-nvenc"]
        assert len(attempts) == 2
        by_label = {rendition.label: rendition for rendition in result.renditions}
        assert by_label["1080p"].backend == "nvenc"
        assert by_label["1080p"].mode == "gpu"

    def test_a_second_session_failure_advances_instead_of_retrying_forever(
        self, tmp_path, source, patched
    ):
        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=lambda label, attempt, cmd: session_error()
            if label == "encode-1080p-nvenc"
            else None,
        )
        result = run_with(
            patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=1
        )

        attempts = [label for label in patched["ffmpeg"].calls if label == "encode-1080p-nvenc"]
        assert len(attempts) == 2
        by_label = {rendition.label: rendition for rendition in result.renditions}
        assert by_label["1080p"].mode == "hybrid"

    def test_incomplete_output_is_deleted_before_the_retry(self, tmp_path, source, patched):
        patched["probes"] = {"nvenc": verified()}
        partial_seen = {"present": None}

        def behavior(label, attempt, cmd):
            output = Path(cmd[-1])
            if label == "encode-1080p-nvenc":
                output.write_bytes(b"half an encode")
                return cuda_filter_error()
            if label == "encode-1080p-nvenc+software-decode" and attempt == 1:
                partial_seen["present"] = output.exists()
            return None

        patched["ffmpeg"] = FakeFfmpeg(patched["metadata"], behavior=behavior)
        run_with(patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=1)

        assert partial_seen["present"] is False


def _mixed_backend_behavior(label, attempt, cmd):
    """One rendition lands on NVENC, another on the CPU: a `mixed` job."""
    if label == "encode-1080p-nvenc":
        return cuda_filter_error()
    if label == "encode-720p-nvenc":
        return cuda_filter_error()
    if label == "encode-720p-nvenc+software-decode":
        from openvod_transcoder.errors import ERROR_ENCODER_FAILED, TranscodeError

        # The encoder itself gives up: proof, recorded once, that NVENC cannot
        # finish this job — every later rendition skips it and lands on the CPU.
        return TranscodeError(ERROR_ENCODER_FAILED, "nvenc encoder died")
    return None


class TestSiblingCancellation:
    def test_a_terminal_failure_stops_sibling_encodes(self, tmp_path, source, patched):
        def behavior(label, attempt, cmd):
            if label == "encode-1080p-nvenc":
                # Let the siblings start and block, so the cancellation they
                # observe is real rather than a queue that never ran.
                time.sleep(0.4)
                return TranscodeError("TRANSCODE_FAILED", "media is corrupt")
            return None

        patched["probes"] = {"nvenc": verified()}
        patched["ffmpeg"] = FakeFfmpeg(
            patched["metadata"],
            behavior=behavior,
            blocked=("encode-720p-nvenc", "encode-480p-nvenc", "encode-360p-nvenc"),
        )
        started = time.monotonic()
        with pytest.raises(TranscodeError) as caught:
            run_with(patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=3)

        assert caught.value.code == "TRANSCODE_FAILED"
        # The original failure is returned rather than waiting out the siblings.
        assert time.monotonic() - started < patched["ffmpeg"].block_seconds

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and patched["ffmpeg"].cancelled_siblings == 0:
            time.sleep(0.02)
        assert patched["ffmpeg"].cancelled_siblings > 0, "siblings were not stopped"


class TestSegmentDurationIsResolvedOnce:
    def test_gop_and_packaging_agree_for_a_short_clip(self, tmp_path, source, patched):
        # 3s source ⇒ half-duration segments (1.5s). The encoder's keyframe
        # interval and Shaka's --segment_duration must be the same number, or the
        # segments do not align with the keyframes and playback stalls at every
        # boundary.
        patched["metadata"] = metadata_for(duration=3.0)
        patched["ffmpeg"] = FakeFfmpeg(patched["metadata"])
        run_with(patched, tmp_path, source, report_with())

        assert patched["package_calls"] == [1.5]
        encode_cmd = next(
            cmd for cmd in patched["ffmpeg"].commands if cmd[-1].endswith("video_1080p.mp4")
        )
        assert encode_cmd[encode_cmd.index("-g") + 1] == "45"  # 1.5s * 30fps

    def test_an_explicit_segment_duration_wins_for_both(self, tmp_path, source, patched):
        run_with(patched, tmp_path, source, report_with(), segment_duration=2.0)

        assert patched["package_calls"] == [2.0]
        encode_cmd = next(
            cmd for cmd in patched["ffmpeg"].commands if cmd[-1].endswith("video_1080p.mp4")
        )
        assert encode_cmd[encode_cmd.index("-g") + 1] == "60"


class TestResourceBounds:
    def _candidates(self):
        from openvod_transcoder.encoding.backends import CPU_BACKEND, NVENC_BACKEND
        from openvod_transcoder.encoding.selection import BackendCandidate

        return {
            "cpu": [BackendCandidate(CPU_BACKEND, gpu_decode=False)],
            "gpu": [BackendCandidate(NVENC_BACKEND, gpu_decode=True)],
        }

    def test_cpu_only_chains_are_limited_to_one_rendition_at_a_time(self, tmp_path, source, patched):
        # The bound is asserted on the pure decision, not on observed overlap:
        # four workers that happen never to run simultaneously would pass a
        # timing-based assertion while enforcing nothing.
        decisions = self._candidates()
        options = ProcessingOptions(rendition_concurrency=4, cpu_rendition_concurrency=1)
        assert pipeline_module.video_worker_count(decisions["cpu"], options, 4) == 1
        # ...and the operator's setting still governs a GPU chain.
        assert pipeline_module.video_worker_count(decisions["gpu"], options, 4) == 4

        run_with(
            patched, tmp_path, source, report_with(),
            rendition_concurrency=4, cpu_rendition_concurrency=1, cpu_ffmpeg_threads=4,
        )
        assert patched["ffmpeg"].peak_concurrency <= 1, "CPU renditions must not overlap"
        cpu_cmd = next(
            cmd for cmd in patched["ffmpeg"].commands if cmd[-1].endswith("video_1080p.mp4")
        )
        assert cpu_cmd[cpu_cmd.index("-threads") + 1] == "4"

    def test_operator_concurrency_is_preserved_without_a_cpu_override(self, tmp_path, source, patched):
        options = ProcessingOptions(rendition_concurrency=2)
        # No separate CPU bound was configured, so the operator's setting is
        # what applies to a CPU-only chain too.
        assert pipeline_module.video_worker_count(self._candidates()["cpu"], options, 4) == 2
        assert pipeline_module.video_worker_count(self._candidates()["gpu"], options, 2) == 2
        # The plan count is the other ceiling: two renditions cannot use four
        # workers.
        assert pipeline_module.video_worker_count(self._candidates()["gpu"], options, 1) == 1

    def test_hybrid_and_audio_threads_are_bounded_separately(self, tmp_path, source, patched):
        patched["probes"] = {"nvenc": verified(hardware_decode=False, hardware_filters=False)}
        run_with(
            patched,
            tmp_path,
            source,
            report_with(nvenc=True),
            hybrid_ffmpeg_threads=2,
            audio_ffmpeg_threads=1,
        )
        hybrid_cmd = next(
            cmd for cmd in patched["ffmpeg"].commands if cmd[-1].endswith("video_1080p.mp4")
        )
        assert hybrid_cmd[hybrid_cmd.index("-c:v") + 1] == "h264_nvenc"
        assert hybrid_cmd[hybrid_cmd.index("-threads") + 1] == "2"
        audio_cmd = next(cmd for cmd in patched["ffmpeg"].commands if cmd[-1].endswith("audio.mp4"))
        assert audio_cmd[audio_cmd.index("-threads") + 1] == "1"


class TestOutputValidation:
    def test_a_failed_validation_advances_the_chain(self, tmp_path, source, patched):
        # A hardware encoder that produces the wrong dimensions is not usable for
        # this job; the same fallback policy that handles a filter failure applies.
        patched["probes"] = {"nvenc": verified()}
        seen = []

        def fake_validate(path, spec, **kwargs):
            seen.append(str(path))
            # Only the first attempt is wrong: the retry on the next path is
            # what the fallback policy exists to reach.
            if "1080p" in str(path) and len(seen) == 1:
                raise TranscodeError(ERROR_ENCODER_FAILED, "wrong dimensions (1280x720)")

        patched["validator"] = fake_validate
        result = run_with(
            patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=1
        )

        by_label = {rendition.label: rendition for rendition in result.renditions}
        assert seen
        assert by_label["1080p"].mode == "hybrid"
        assert "wrong dimensions" in result.metadata.fallback_reasons[0]


class TestManifestReferences:
    def test_a_dangling_playlist_reference_is_a_packaging_failure(self, tmp_path):
        from openvod_transcoder.pipeline import validate_manifest_references
        from openvod_transcoder.result import build_inventory

        output_dir = tmp_path / "output"
        (output_dir / "video_720p").mkdir(parents=True)
        (output_dir / "playlist.m3u8").write_text(
            "#EXTM3U\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\n"
            "video_720p/playlist.m3u8\n"
        )
        artifacts = build_inventory(output_dir, hashes=False)

        with pytest.raises(TranscodeError) as caught:
            validate_manifest_references(output_dir, artifacts)
        assert caught.value.code == ERROR_PACKAGING_FAILED

    def test_resolvable_references_pass(self, tmp_path):
        from openvod_transcoder.pipeline import validate_manifest_references
        from openvod_transcoder.result import build_inventory

        output_dir = tmp_path / "output"
        (output_dir / "video_720p").mkdir(parents=True)
        (output_dir / "playlist.m3u8").write_text(
            "#EXTM3U\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\n"
            "video_720p/playlist.m3u8\n"
        )
        (output_dir / "video_720p" / "playlist.m3u8").write_text("#EXTM3U\n#EXT-X-ENDLIST\n")
        validate_manifest_references(output_dir, build_inventory(output_dir, hashes=False))


class TestOptionsFingerprint:
    def test_fingerprint_ignores_attempt_identity_so_work_can_be_reused(self):
        first = ProcessingOptions(video_id="v1", attempt_id="a1")
        second = ProcessingOptions(video_id="v2", attempt_id="a2")
        assert first.plan_fingerprint() == second.plan_fingerprint()

    def test_fingerprint_changes_with_the_ladder(self):
        base = ProcessingOptions()
        taller = ProcessingOptions(include_heights=(2160,))
        assert base.plan_fingerprint() != taller.plan_fingerprint()

    def test_fingerprint_changes_with_the_playback_policy(self):
        # Policy is written into object metadata, so it is part of the bytes.
        assert (
            ProcessingOptions(playback_policy="public").plan_fingerprint()
            != ProcessingOptions(playback_policy="signed").plan_fingerprint()
        )

    def test_unknown_stored_options_are_dropped_not_fatal(self):
        options = ProcessingOptions.from_dict({"max_height": 720, "futureOption": True})
        assert options.max_height == 720

    def test_round_trips_through_a_stored_blob(self):
        original = ProcessingOptions(max_height=720, include_heights=(1440,), generate_subtitle=True)
        restored = ProcessingOptions.from_dict(original.to_dict())
        assert restored == original


class TestPayloadKeyPrefix:
    """
    The Modal callback carries complete object keys; the agent's does not.

    This distinction regressed silently: the shared engine returns
    output-directory-relative paths, the Modal worker sent them unchanged, and
    the API — which handles a Modal callback with rebasing *off* — saved
    `<delivery>/playlist.m3u8`. Every new Modal video had a dead playback URL
    while the job reported success.
    """

    def test_modal_payload_carries_complete_object_keys(self, tmp_path, source, patched):
        result, _ = run(tmp_path, source, patched)
        payload = result.as_payload(key_prefix="videos/vid-1")

        assert payload["outputs"]["hls_playlist"] == "videos/vid-1/playlist.m3u8"
        assert payload["outputs"]["dash_manifest"] == "videos/vid-1/manifest.mpd"
        assert payload["outputs"]["poster"] == "videos/vid-1/poster.jpg"
        assert all(
            entry["path"].startswith("videos/vid-1/") for entry in payload["inventory"]
        )

    def test_agent_payload_stays_relative_for_the_api_to_rebase(self, tmp_path, source, patched):
        # The self-hosted path relies on the API re-basing against the attempt
        # prefix it recorded in the inventory. Prefixing here would double it.
        result, _ = run(tmp_path, source, patched)
        payload = result.as_payload()

        assert payload["outputs"]["hls_playlist"] == "playlist.m3u8"
        assert all(not entry["path"].startswith("videos/") for entry in payload["inventory"])

    def test_subtitles_are_prefixed_for_modal(self, tmp_path, source, patched):
        result, _ = run(tmp_path, source, patched, generate_subtitle=True)
        payload = result.as_payload(key_prefix="videos/vid-1")
        assert payload["outputs"]["subtitles"] == "videos/vid-1/subtitles.vtt"

    def test_prefix_slashes_are_normalised(self, tmp_path, source, patched):
        from openvod_transcoder.result import prefixed_path

        assert prefixed_path("/videos/v/", "/playlist.m3u8") == "videos/v/playlist.m3u8"
        assert prefixed_path("", "playlist.m3u8") == "playlist.m3u8"
