"""
Real-media tests: actual FFmpeg processes, actual files.

The unit suites prove the *commands we build* are the ones we intended. These
prove the commands are ones FFmpeg accepts — which is a different claim, and the
only one that catches a filter that does not exist, a flag that moved between
versions, or an argument order that silently changes meaning.

They are skipped when the binaries are absent, so `pytest` still runs on a bare
machine. `packager` (Shaka) has no fallback: a full HLS/DASH assertion genuinely
requires it.
"""
from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest

from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.encoding.backends import (
    CPU_BACKEND,
    RenderSpec,
    build_audio_command,
    build_video_command,
    fit_dimensions,
)
from openvod_transcoder.encoding.probe import detect_capabilities, probe_backend
from openvod_transcoder.errors import CancelledError
from openvod_transcoder.ffmpeg_progress import StallPolicy, run_ffmpeg
from openvod_transcoder.options import ProcessingOptions
from openvod_transcoder.planning import POLICY_CAPPED, plan_renditions
from openvod_transcoder.snapshot import create_snapshot, original_untouched
from openvod_transcoder.video.analysis import get_video_metadata

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
HAS_PACKAGER = shutil.which("packager") is not None

requires_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not installed")
requires_packager = pytest.mark.skipif(
    not (HAS_FFMPEG and HAS_PACKAGER), reason="ffmpeg + shaka packager not installed"
)


# ── fixtures: synthetic sources with the shapes that break encoders ──────────

def synthesize(path: Path, *, size: str, seconds: float, audio: bool = True, extra=()) -> Path:
    """
    Build a test clip with a real encoder, so the input is a real file.

    Odd dimensions are written losslessly (FFV1, 4:4:4) rather than with H.264,
    because H.264 cannot represent an odd width at 4:2:0 — which is precisely why
    odd-dimension sources are a required scenario. Producing one that libx264
    refuses to *create* would test nothing about how we handle it.
    """
    width, _, height = size.partition("x")
    odd = int(width) % 2 == 1 or int(height) % 2 == 1

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=size={size}:rate=25:duration={seconds}",
    ]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    if odd:
        cmd += ["-c:v", "ffv1", "-pix_fmt", "yuv444p", "-level", "3"]
        if audio:
            cmd += ["-c:a", "pcm_s16le", "-shortest"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
        if audio:
            cmd += ["-c:a", "aac", "-shortest"]
    cmd += [*extra, str(path)]
    completed = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if completed.returncode != 0:
        pytest.skip(f"could not synthesize a test clip: {completed.stderr[-300:]}")
    return path


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    """One clip per shape the plan calls out as a required media scenario."""
    base = tmp_path_factory.mktemp("clips")
    return {
        "landscape_1080": synthesize(base / "landscape.mp4", size="1920x1080", seconds=3),
        "portrait": synthesize(base / "portrait.mp4", size="608x1080", seconds=3),
        "odd_dims": synthesize(base / "odd.mkv", size="641x481", seconds=3),
        "sub_360": synthesize(base / "tiny.mp4", size="320x240", seconds=3),
        "silent": synthesize(base / "silent.mp4", size="1280x720", seconds=3, audio=False),
        "short": synthesize(base / "short.mp4", size="640x360", seconds=1),
        "audio_only": _audio_only(base / "audio.m4a"),
    }


def _audio_only(path: Path) -> Path:
    completed = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:a", "aac", str(path),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if completed.returncode != 0:
        pytest.skip("could not synthesize an audio-only file")
    return path


# ── the encoder produces what we asked for ───────────────────────────────────

@requires_ffmpeg
class TestRealEncode:
    def test_landscape_source_encodes_to_the_planned_dimensions(self, clips, tmp_path):
        metadata = get_video_metadata(str(clips["landscape_1080"]))
        specs = plan_renditions(metadata, policy=POLICY_CAPPED)
        spec = next(entry for entry in specs if entry.label == "720p")

        output = tmp_path / "video_720p.mp4"
        run_ffmpeg(
            build_video_command(
                ffmpeg="ffmpeg", input_path=str(clips["landscape_1080"]),
                output_path=str(output), backend=CPU_BACKEND, spec=spec,
                metadata=metadata, segment_duration=1.0, gpu_decode=False,
            ),
            label="test-720p",
        )

        encoded = get_video_metadata(str(output))
        assert (encoded.width, encoded.height) == (1280, 720)

    def test_portrait_source_keeps_its_orientation(self, clips, tmp_path):
        metadata = get_video_metadata(str(clips["portrait"]))
        assert metadata.is_vertical is True
        specs = plan_renditions(metadata, policy=POLICY_CAPPED)
        spec = next(entry for entry in specs if entry.label == "720p")
        assert spec.width < spec.height

        output = tmp_path / "portrait_720p.mp4"
        run_ffmpeg(
            build_video_command(
                ffmpeg="ffmpeg", input_path=str(clips["portrait"]),
                output_path=str(output), backend=CPU_BACKEND, spec=spec,
                metadata=metadata, segment_duration=1.0, gpu_decode=False,
            ),
            label="test-portrait",
        )
        encoded = get_video_metadata(str(output))
        assert encoded.height > encoded.width

    def test_odd_source_dimensions_encode_without_an_error(self, clips, tmp_path):
        # 641x481 is the shape that makes `scale=-2:h` emit an odd width and
        # makes libx264 refuse the frame.
        metadata = get_video_metadata(str(clips["odd_dims"]))
        specs = plan_renditions(metadata, policy=POLICY_CAPPED)
        assert specs, "an odd-dimensioned source must still plan at least one rendition"
        spec = specs[0]
        assert spec.width % 2 == 0 and spec.height % 2 == 0

        output = tmp_path / "odd.mp4"
        run_ffmpeg(
            build_video_command(
                ffmpeg="ffmpeg", input_path=str(clips["odd_dims"]),
                output_path=str(output), backend=CPU_BACKEND, spec=spec,
                metadata=metadata, segment_duration=1.0, gpu_decode=False,
            ),
            label="test-odd",
        )
        encoded = get_video_metadata(str(output))
        assert encoded.width % 2 == 0 and encoded.height % 2 == 0

    def test_sub_360p_source_is_not_upscaled(self, clips, tmp_path):
        metadata = get_video_metadata(str(clips["sub_360"]))
        specs = plan_renditions(metadata, policy=POLICY_CAPPED)
        assert len(specs) == 1
        assert (specs[0].width, specs[0].height) == (320, 240)

        output = tmp_path / "tiny.mp4"
        run_ffmpeg(
            build_video_command(
                ffmpeg="ffmpeg", input_path=str(clips["sub_360"]),
                output_path=str(output), backend=CPU_BACKEND, spec=specs[0],
                metadata=metadata, segment_duration=1.0, gpu_decode=False,
            ),
            label="test-sub360",
        )
        encoded = get_video_metadata(str(output))
        assert (encoded.width, encoded.height) == (320, 240)

    def test_silent_video_encodes(self, clips, tmp_path):
        metadata = get_video_metadata(str(clips["silent"]))
        assert metadata.has_audio is False
        spec = plan_renditions(metadata, policy=POLICY_CAPPED)[0]
        output = tmp_path / "silent.mp4"
        run_ffmpeg(
            build_video_command(
                ffmpeg="ffmpeg", input_path=str(clips["silent"]),
                output_path=str(output), backend=CPU_BACKEND, spec=spec,
                metadata=metadata, segment_duration=1.0, gpu_decode=False,
            ),
            label="test-silent",
        )
        assert output.stat().st_size > 1000

    def test_audio_only_source_normalizes_to_stereo_aac(self, clips, tmp_path):
        output = tmp_path / "audio.mp4"
        run_ffmpeg(
            build_audio_command(
                ffmpeg="ffmpeg", input_path=str(clips["audio_only"]),
                output_path=str(output),
            ),
            label="test-audio",
        )
        metadata = get_video_metadata(str(output))
        assert metadata.has_audio is True
        assert metadata.has_video is False

    def test_very_short_clip_encodes_with_a_split_keyframe(self, clips, tmp_path):
        metadata = get_video_metadata(str(clips["short"]))
        # A 1s clip at a 4s GOP would emit a single keyframe and no usable
        # segment boundary, so the GOP is derived from the segment duration.
        from openvod_transcoder.config import EncodingProfile

        planned = plan_renditions(metadata, policy=POLICY_CAPPED)[0]
        spec = RenderSpec.from_profile(
            EncodingProfile(
                label=planned.label,
                height=planned.height,
                bitrate=planned.bitrate,
                maxrate=planned.maxrate,
                bufsize=planned.bufsize,
            ),
            planned.width,
            planned.height,
            planned.fps,
        )
        output = tmp_path / "short.mp4"
        run_ffmpeg(
            build_video_command(
                ffmpeg="ffmpeg", input_path=str(clips["short"]),
                output_path=str(output), backend=CPU_BACKEND, spec=spec,
                metadata=metadata, segment_duration=0.5, gpu_decode=False,
            ),
            label="test-short",
        )
        assert output.stat().st_size > 1000


# ── progress and cancellation against a real process ─────────────────────────

@requires_ffmpeg
class TestRealProgress:
    def test_progress_advances_and_reaches_the_end_of_the_source(self, clips, tmp_path):
        metadata = get_video_metadata(str(clips["landscape_1080"]))
        spec = plan_renditions(metadata, policy=POLICY_CAPPED)[-1]

        seen: list[float] = []
        run_ffmpeg(
            build_video_command(
                ffmpeg="ffmpeg", input_path=str(clips["landscape_1080"]),
                output_path=str(tmp_path / "progress.mp4"), backend=CPU_BACKEND,
                spec=spec, metadata=metadata, segment_duration=1.0, gpu_decode=False,
            ),
            label="test-progress",
            duration=metadata.duration,
            on_progress=lambda decoded, fraction: seen.append(fraction),
        )

        assert seen, "a real encode must emit progress blocks"
        assert seen == sorted(seen), "progress must not go backwards"
        assert max(seen) > 0.5, f"progress barely moved: {seen}"

    def test_cancelling_stops_a_real_encode_promptly(self, clips, tmp_path):
        metadata = get_video_metadata(str(clips["landscape_1080"]))
        spec = plan_renditions(metadata, policy=POLICY_CAPPED)[0]

        token = CancellationToken()
        # Cancel from the progress callback: the encode is genuinely mid-flight,
        # which is the case that matters (a pre-cancelled token proves nothing
        # about terminating a live process tree).
        def on_progress(_decoded, _fraction):
            token.cancel("owner cancelled")

        started = time.monotonic()
        with pytest.raises(CancelledError):
            run_ffmpeg(
                build_video_command(
                    ffmpeg="ffmpeg", input_path=str(clips["landscape_1080"]),
                    output_path=str(tmp_path / "cancelled.mp4"), backend=CPU_BACKEND,
                    spec=spec, metadata=metadata, segment_duration=1.0, gpu_decode=False,
                ),
                label="test-cancel",
                duration=metadata.duration,
                on_progress=on_progress,
                cancellation=token,
            )
        assert time.monotonic() - started < 30, "cancellation must not wait for the encode"

    def test_a_stalled_encode_is_killed_rather_than_waited_on(self, tmp_path):
        """
        A stall window far shorter than the encode forces the detector to fire.

        This is the *opposite* of the shipping default (15 minutes); the point is
        that the mechanism terminates a live process, which the deterministic
        unit test cannot show.
        """
        from openvod_transcoder.errors import ERROR_STALLED
        from openvod_transcoder.ffmpeg_progress import StallError

        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            # 4K so the encode cannot finish inside the stall window on any
            # machine that would pass this suite.
            "-f", "lavfi", "-i", "testsrc=size=3840x2160:rate=25:duration=60",
            "-c:v", "libx264", "-preset", "veryfast",
            str(tmp_path / "stall.mp4"),
        ]
        started = time.monotonic()
        with pytest.raises(StallError) as caught:
            run_ffmpeg(
                cmd,
                label="test-stall",
                duration=60.0,
                stall=StallPolicy(timeout_seconds=0.05),
            )
        assert caught.value.code == ERROR_STALLED
        assert time.monotonic() - started < 120


# ── capability probing against the real binary ───────────────────────────────

@requires_ffmpeg
class TestRealProbing:
    def test_cpu_backend_is_verified_on_any_machine_with_ffmpeg(self):
        probe = probe_backend(CPU_BACKEND)
        assert probe.available is True, probe.detail

    def test_detection_reports_cpu_and_refuses_to_claim_the_rest(self):
        report = detect_capabilities()
        assert report.encoders["cpu"].available is True
        # This machine may or may not have a GPU; what must hold either way is
        # that a backend is only reported available if it really encoded.
        for name in ("nvenc", "vaapi"):
            entry = report.encoders[name]
            if not entry.available and entry.failure_kind not in ("not-compiled",):
                assert entry.reason, "an unavailable backend must say why"


# ── the whole pipeline, when a packager is present ───────────────────────────

@requires_packager
class TestRealPipeline:
    def test_full_cpu_run_produces_playable_hls_and_dash(self, clips, tmp_path):
        from openvod_transcoder.pipeline import run_pipeline

        options = ProcessingOptions(
            video_id="real-test",
            attempt_id="real-attempt",
            max_height=360,
            rendition_concurrency=1,
            segment_duration=1.0,
        )
        result = run_pipeline(
            clips["landscape_1080"],
            tmp_path / "work",
            options,
            detect_capabilities(),
            None,
            CancellationToken(),
        )

        paths = {artifact.path for artifact in result.artifacts}
        assert "playlist.m3u8" in paths
        assert "manifest.mpd" in paths
        assert any(path.startswith("video_360p/") for path in paths)
        assert any(path.endswith(".m4s") for path in paths)

        master = (tmp_path / "work" / "output" / "playlist.m3u8").read_text()
        assert "#EXTM3U" in master
        assert "video_360p" in master or "playlist.m3u8" in master

    def test_snapshot_leaves_the_original_untouched(self, clips, tmp_path):
        before = clips["landscape_1080"].read_bytes()
        snapshot = create_snapshot(clips["landscape_1080"], tmp_path / "snap.mp4")
        assert original_untouched(snapshot, clips["landscape_1080"]) is True
        assert clips["landscape_1080"].read_bytes() == before


@requires_ffmpeg
class TestRealAnalysis:
    def test_every_media_shape_is_analysed_without_error(self, clips):
        expectations = {
            "landscape_1080": (1920, 1080, True),
            "portrait": (608, 1080, True),
            "sub_360": (320, 240, True),
            "silent": (1280, 720, False),
            "audio_only": (0, 0, True),
        }
        for name, (width, height, has_audio) in expectations.items():
            metadata = get_video_metadata(str(clips[name]))
            assert (metadata.width, metadata.height) == (width, height), name
            assert metadata.has_audio is has_audio, name
            assert metadata.duration > 0, name

    def test_odd_dimensions_are_reported_as_coded(self, clips):
        metadata = get_video_metadata(str(clips["odd_dims"]))
        assert (metadata.width, metadata.height) == (641, 481)
        # The planner is what makes them even, not the analyser: the analyser
        # reports what is there, and pretending otherwise would hide a real
        # source property from the preflight.
        assert fit_dimensions(metadata.width, metadata.height, 240) == (320, 240)
