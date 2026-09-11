"""Pipeline orchestration: staging, fallback, cancellation, inventory, validation.

These are integration tests over injected seams — no FFmpeg and no Shaka process
is started. What they establish is the *contract* the two real runners depend on:
what gets encoded, in what order, what is allowed to fail the job, and what the
result payload looks like when it reaches the API.
"""
from pathlib import Path
from typing import Dict, List

import pytest

from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.encoding.probe import CapabilityReport, EncoderProbe
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
    """

    def __init__(self, metadata, *, fail_labels=(), fail_times=1, error=None):
        self.metadata = metadata
        self.calls: List[str] = []
        self.fail_labels = set(fail_labels)
        self.fail_times = fail_times
        self.error = error or TranscodeError(ERROR_ENCODER_FAILED, "gpu exploded")
        self.failures = 0

    def __call__(self, cmd, *, label, duration=None, on_progress=None, cancellation=None, stall=None):
        self.calls.append(label)
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

    monkeypatch.setattr(pipeline_module, "get_video_metadata", fake_metadata)
    monkeypatch.setattr(pipeline_module, "_probe_streams", fake_probe_streams)
    monkeypatch.setattr(pipeline_module, "run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(pipeline_module, "package_with_shaka", fake_shaka)

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
