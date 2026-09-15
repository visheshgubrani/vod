"""Whisper subtitle generation: GPU first, CPU as a *retry*, never a partial VTT.

Two defects motivate this suite, and both were reachable in production:

1. Transcription ran on CUDA only. A host whose driver, cuDNN or CTranslate2
   build disagreed with the image failed the enrichment, so a perfectly good
   video shipped without subtitles even though the CPU could have produced them.
2. The VTT was written *while* Whisper's segments were being iterated, and
   `segments` is a lazy generator: a failure half way through left a truncated
   subtitle file on disk that the inventory then published as if it were
   complete. A subtitle track that stops mid-sentence is worse than none.

The fakes below stand in for `faster_whisper` because the engine must import
without it (`test_engine_isolation.py` enforces that); the behaviour they fake —
a lazy generator that raises on the second segment — is exactly what the library
does when the GPU gives up mid-file.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from clipmux_transcoder.video import transcription as transcription_module
from clipmux_transcoder.video.transcription import (
    format_timestamp,
    is_gpu_runtime_failure,
    transcribe_to_vtt,
)


class Cue:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text
        self.words = None


class Info:
    language = "en"
    language_probability = 0.99


SEGMENTS = [Cue(0.0, 1.5, "Hello there."), Cue(1.5, 3.0, "General Kenobi.")]


class FakeModel:
    """A model whose `transcribe` returns a *lazy* generator, like the real one."""

    def __init__(self, log, *, segments=SEGMENTS, fail_after=None, error=None):
        self._log = log
        self._segments = segments
        self._fail_after = fail_after
        self._error = error

    def transcribe(self, audio_path, **options):
        self._log[-1]["options"] = options
        self._log[-1]["audio"] = str(audio_path)

        def generator():
            for index, segment in enumerate(self._segments):
                if self._fail_after is not None and index >= self._fail_after:
                    raise self._error
                yield segment

        return generator(), Info()


def install_fake_whisper(monkeypatch, log, *, make_model, batched=False):
    """
    Install a fake `faster_whisper` whose model factory is supplied per attempt.

    ``make_model(device, log)`` is called once per transcription attempt with the
    device the engine chose, so a test can make the GPU fail and the CPU succeed
    — which is the whole behaviour under test.
    """
    module = types.ModuleType("faster_whisper")

    def WhisperModel(model_size, *, device, compute_type):
        log.append({"model": model_size, "device": device, "compute_type": compute_type})
        return make_model(device, log)

    module.WhisperModel = WhisperModel
    if batched:
        class BatchedInferencePipeline:
            def __init__(self, model):
                self._model = model

            def transcribe(self, audio_path, batch_size=8, **options):
                return self._model.transcribe(audio_path, **options)

        module.BatchedInferencePipeline = BatchedInferencePipeline
    monkeypatch.setitem(sys.modules, "faster_whisper", module)


def fails_on(device, log, *, error, fail_after=0):
    """A factory that fails on one device and succeeds on the other."""
    def make_model(chosen, _log):
        if chosen == device:
            return FakeModel(log, fail_after=fail_after, error=error)
        return FakeModel(log)
    return make_model


@pytest.fixture()
def source(tmp_path, monkeypatch):
    """A source file plus a stubbed `extract_audio` (no real FFmpeg here)."""
    path = tmp_path / "lesson.mp4"
    path.write_bytes(b"media" * 100)

    def fake_extract(input_path, output_path):
        Path(output_path).write_bytes(b"RIFF")
        return Path(output_path)

    monkeypatch.setattr(transcription_module, "extract_audio", fake_extract)
    return path


class TestGpuFailureRecognition:
    def test_cuda_runtime_failures_are_recognised(self):
        assert is_gpu_runtime_failure(RuntimeError("CUDA failed with error out of memory"))
        assert is_gpu_runtime_failure(RuntimeError("cuDNN error: CUDNN_STATUS_NOT_INITIALIZED"))
        assert is_gpu_runtime_failure(RuntimeError("Library cublas64_12.so is not found"))
        assert is_gpu_runtime_failure(RuntimeError("no CUDA-capable device is detected"))

    def test_ordinary_failures_are_not_gpu_failures(self):
        # Retrying an unsupported language on the CPU wastes minutes and fails
        # identically; only GPU-shaped errors are worth a retry.
        assert is_gpu_runtime_failure(ValueError("Unsupported language: 'xx'")) is False
        assert is_gpu_runtime_failure(FileNotFoundError("no such model")) is False


class TestCudaThenCpu:
    def test_a_gpu_failure_retries_on_cpu_with_int8_and_the_same_model(
        self, tmp_path, source, monkeypatch
    ):
        log = []
        install_fake_whisper(
            monkeypatch, log,
            make_model=fails_on(
                "cuda", log, error=RuntimeError("CUDA driver version is insufficient")
            ),
        )

        output = tmp_path / "subtitles.vtt"
        transcribe_to_vtt(source, output, model_size="large-v3-turbo", language="en")

        assert [entry["device"] for entry in log] == ["cuda", "cpu"]
        assert log[0]["compute_type"] == "float16"
        assert log[1]["compute_type"] == "int8"
        # Same model and same language settings on both attempts.
        assert {entry["model"] for entry in log} == {"large-v3-turbo"}
        assert {entry["options"]["language"] for entry in log} == {"en"}
        assert output.read_text().count("-->") == 2

    def test_a_failure_during_lazy_segment_iteration_triggers_the_retry(
        self, tmp_path, source, monkeypatch
    ):
        log = []
        install_fake_whisper(
            monkeypatch, log,
            make_model=fails_on(
                "cuda", log,
                error=RuntimeError("CUDA error: an illegal memory access"),
                fail_after=1,
            ),
        )

        output = tmp_path / "subtitles.vtt"
        transcribe_to_vtt(source, output)

        text = output.read_text()
        assert [entry["device"] for entry in log] == ["cuda", "cpu"]
        # Only the successful pass is published: no duplicate cue from the
        # partial GPU attempt, and no truncation.
        assert text.count("Hello there.") == 1
        assert text.count("General Kenobi.") == 1

    def test_a_non_gpu_failure_is_not_retried_and_publishes_nothing(
        self, tmp_path, source, monkeypatch
    ):
        log = []
        install_fake_whisper(
            monkeypatch, log,
            make_model=lambda device, _log: FakeModel(
                log, fail_after=0, error=ValueError("Unsupported language: 'xx'")
            ),
        )
        output = tmp_path / "subtitles.vtt"

        with pytest.raises(ValueError):
            transcribe_to_vtt(source, output, language="xx")

        assert len(log) == 1, "a non-GPU failure must not trigger a CPU retry"
        assert not output.exists(), "a failed transcription must publish no VTT"

    def test_no_partial_vtt_survives_a_cpu_failure_either(
        self, tmp_path, source, monkeypatch
    ):
        log = []

        def make_model(device, _log):
            return FakeModel(
                log,
                fail_after=1,
                error=RuntimeError("CUDA failure" if device == "cuda" else "CPU failure"),
            )

        install_fake_whisper(monkeypatch, log, make_model=make_model)
        output = tmp_path / "subtitles.vtt"

        with pytest.raises(RuntimeError, match="CPU failure"):
            transcribe_to_vtt(source, output)

        assert [entry["device"] for entry in log] == ["cuda", "cpu"]
        assert not output.exists()
        assert not list(tmp_path.glob("*.tmp")), "no temporary VTT may be left behind"


class TestVttShape:
    def test_timestamps_are_vtt_shaped(self):
        assert format_timestamp(0.0) == "00:00:00.000"
        assert format_timestamp(3723.5) == "01:02:03.500"

    def test_written_file_is_a_complete_webvtt_document(self, tmp_path, source, monkeypatch):
        log = []
        install_fake_whisper(
            monkeypatch, log, make_model=lambda device, _log: FakeModel(log)
        )
        output = tmp_path / "subtitles.vtt"
        transcribe_to_vtt(source, output)

        text = output.read_text()
        assert text.startswith("WEBVTT\n\n")
        assert "00:00:00.000 --> 00:00:01.500" in text

    def test_batched_pipeline_is_used_when_the_library_offers_it(
        self, tmp_path, source, monkeypatch
    ):
        log = []
        install_fake_whisper(
            monkeypatch, log,
            make_model=lambda device, _log: FakeModel(log),
            batched=True,
        )
        transcribe_to_vtt(source, tmp_path / "subtitles.vtt")
        assert log[0]["device"] == "cuda"


class TestAttemptPlan:
    def test_an_empty_attempt_plan_is_refused_rather_than_publishing_nothing(
        self, tmp_path, source, monkeypatch
    ):
        # An empty plan would skip the loop and write a header-only VTT, which
        # downstream cannot distinguish from "the video has no speech".
        log = []
        install_fake_whisper(monkeypatch, log, make_model=lambda device, _log: FakeModel(log))
        output = tmp_path / "subtitles.vtt"

        with pytest.raises(ValueError, match="at least one"):
            transcribe_to_vtt(source, output, attempts=())

        assert log == []
        assert not output.exists()
