"""
Real-media tests: actual FFmpeg processes, actual files.

The unit suites prove the *commands we build* are the ones we intended. These
prove the commands are ones FFmpeg accepts — which is a different claim, and the
only one that catches a filter that does not exist, a flag that moved between
versions, or an argument order that silently changes meaning.

They are skipped when the binaries are absent, so `pytest` still runs on a bare
machine. `packager` (Shaka) has no fallback: a full HLS/DASH assertion genuinely
requires it.

CI sets ``CLIPMUX_REQUIRE_MEDIA_TOOLS=1`` after installing both, which turns a
missing binary into a *failure* rather than a skip. Without that, a CI job that
lost its ffmpeg install would report a green run while testing none of this —
the silent-skip failure mode, which is the one this suite exists to prevent.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from clipmux_transcoder.cancellation import CancellationToken
from clipmux_transcoder.encoding.backends import (
    CPU_BACKEND,
    RenderSpec,
    build_audio_command,
    build_video_command,
    fit_dimensions,
)
from clipmux_transcoder.encoding.probe import detect_capabilities, probe_backend
from clipmux_transcoder.errors import CancelledError
from clipmux_transcoder.ffmpeg_progress import StallPolicy, run_ffmpeg
from clipmux_transcoder.options import ProcessingOptions
from clipmux_transcoder.planning import POLICY_CAPPED, plan_renditions
from clipmux_transcoder.snapshot import create_snapshot, original_untouched
from clipmux_transcoder.video.analysis import get_video_metadata

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
HAS_PACKAGER = shutil.which("packager") is not None

# CI opts into "a missing binary is a broken build, not a skipped test".
REQUIRE_MEDIA_TOOLS = os.environ.get("CLIPMUX_REQUIRE_MEDIA_TOOLS") == "1"

if REQUIRE_MEDIA_TOOLS and not HAS_FFMPEG:
    raise RuntimeError(
        "CLIPMUX_REQUIRE_MEDIA_TOOLS=1 but ffmpeg/ffprobe are not on PATH — "
        "CI must install them, or these suites silently stop testing anything"
    )
if REQUIRE_MEDIA_TOOLS and not HAS_PACKAGER:
    raise RuntimeError(
        "CLIPMUX_REQUIRE_MEDIA_TOOLS=1 but shaka packager is not on PATH — "
        "packaging would be skipped and no playable output would ever be asserted"
    )

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


def run_ffmpeg_raw(args, *, timeout=300) -> bool:
    """Best-effort synthesis. Returns False when the local build cannot do it."""
    completed = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if completed.returncode != 0:
        print(f"[synthesis] skipped: {' '.join(args[-3:])}: {completed.stderr[-200:]}")
        return False
    return True


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    """
    One clip per shape the plan calls out as a required media scenario.

    The container/codec variants (AV1/Opus WebM, VP9 WebM, 10-bit HEVC and HDR,
    4:2:2/4:4:4, VFR, rotated) are *optional*: they are skipped individually when
    the local FFmpeg lacks the encoder, rather than skipping the whole suite.
    """
    base = tmp_path_factory.mktemp("clips")
    matrix = {
        "landscape_1080": synthesize(base / "landscape.mp4", size="1920x1080", seconds=3),
        "portrait": synthesize(base / "portrait.mp4", size="608x1080", seconds=3),
        "odd_dims": synthesize(base / "odd.mkv", size="641x481", seconds=3),
        "sub_360": synthesize(base / "tiny.mp4", size="320x240", seconds=3),
        "silent": synthesize(base / "silent.mp4", size="1280x720", seconds=3, audio=False),
        "short": synthesize(base / "short.mp4", size="640x360", seconds=1),
        "audio_only": _audio_only(base / "audio.m4a"),
        "hevc_10bit": _hevc_10bit(base / "hevc10.mkv"),
        "hdr10": _hdr10(base / "hdr10.mkv"),
        "av1_opus": _av1_opus_webm(base / "av1-opus.webm"),
        "vp9_opus": _vp9_opus_webm(base / "vp9-opus.webm"),
        "yuv422": _chroma(base / "yuv422.mkv", "yuv422p"),
        "yuv444": _chroma(base / "yuv444.mkv", "yuv444p"),
        "rotated": _rotated(base / "rotated.mp4"),
        "vfr": _variable_frame_rate(base / "vfr.mp4"),
    }
    return {name: path for name, path in matrix.items() if path is not None}


def _hevc_10bit(path: Path):
    """10-bit HEVC — the profile whose hardware decode we do not assume."""
    if run_ffmpeg_raw([
        "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3",
        "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error",
        "-pix_fmt", "yuv420p10le", str(path),
    ]):
        return path
    return None


def _hdr10(path: Path):
    """
    HDR10: PQ transfer, BT.2020 primaries, 10-bit.

    The transfer characteristic is written through x265's own VUI parameters —
    the generic `-color_trc` flag alone does not reach the bitstream in every
    build, and an HDR clip that is not *tagged* as HDR tests nothing.
    """
    if run_ffmpeg_raw([
        "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3",
        "-c:v", "libx265", "-preset", "ultrafast",
        "-x265-params",
        "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc"
        ":master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)"
        ":max-cll=1000,400",
        "-pix_fmt", "yuv420p10le", str(path),
    ]):
        return path
    return None


def _av1_opus_webm(path: Path):
    """The reported source shape: AV1 video with Opus audio in a WebM container."""
    if run_ffmpeg_raw([
        "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-c:v", "libsvtav1", "-preset", "12", "-c:a", "libopus", "-shortest", str(path),
    ]):
        return path
    return None


def _vp9_opus_webm(path: Path):
    if run_ffmpeg_raw([
        "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
        "-c:a", "libopus", "-shortest", str(path),
    ]):
        return path
    return None


def _chroma(path: Path, pixel_format: str):
    """4:2:2 / 4:4:4 lossless: the chroma shapes H.264 High profile rejects."""
    if run_ffmpeg_raw([
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2",
        "-c:v", "ffv1", "-pix_fmt", pixel_format, "-level", "3", str(path),
    ]):
        return path
    return None


def _rotated(path: Path):
    """
    A file whose *display matrix* says 90°, like a phone recording.

    `-display_rotation` is an input option that writes the side data; the older
    `-metadata:s:v rotate=90` tag is no longer turned into a display matrix by
    modern FFmpeg, and a file without side data would not test rotation at all.
    """
    plain = path.with_name("rotated-plain.mp4")
    if not run_ffmpeg_raw([
        "-f", "lavfi", "-i", "testsrc=size=1080x608:rate=25:duration=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(plain),
    ]):
        return None
    if not run_ffmpeg_raw(["-display_rotation", "90", "-i", str(plain), "-c", "copy", str(path)]):
        return None
    return path


def _variable_frame_rate(path: Path):
    """Two clips at different rates concatenated: a genuinely variable stream."""
    first = path.with_name("vfr-a.mp4")
    second = path.with_name("vfr-b.mp4")
    parts = [
        (first, "25"),
        (second, "50"),
    ]
    for target, rate in parts:
        if not run_ffmpeg_raw([
            "-f", "lavfi", "-i", f"testsrc=size=320x240:rate={rate}:duration=2",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(target),
        ]):
            return None
    listing = path.with_suffix(".txt")
    listing.write_text(f"file '{first}'\nfile '{second}'\n")
    if not run_ffmpeg_raw([
        "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(path),
    ]):
        return None
    return path


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
        from clipmux_transcoder.config import EncodingProfile

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
        from clipmux_transcoder.errors import ERROR_STALLED
        from clipmux_transcoder.ffmpeg_progress import StallError

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
        from clipmux_transcoder.pipeline import run_pipeline

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

        output_dir = tmp_path / "work" / "output"
        master = (output_dir / "playlist.m3u8").read_text()
        assert "#EXTM3U" in master

        # Shaka writes the per-rendition media playlists beside the master
        # (`stream_N.m3u8`) and those reference the segment templates. Asserting
        # against the real layout rather than an assumed one is the point: the
        # previous assertion here checked for a filename Shaka never writes.
        media_playlists = [
            path
            for path in sorted(output_dir.glob("stream_*.m3u8"))
            if "video_360p/" in path.read_text()
        ]
        assert media_playlists, "no video media playlist was written"
        video_playlist = media_playlists[0].read_text()
        assert "video_360p/init.mp4" in video_playlist
        assert "video_360p/1.m4s" in video_playlist
        assert "#EXT-X-ENDLIST" in video_playlist

        # Segment alignment: every advertised segment is about as long as the
        # segment duration the encoder was given, so the keyframes the GOP places
        # land exactly on the boundaries the packager cuts at. A drift here makes
        # players stall at every switch.
        durations = [float(value) for value in re.findall(r"#EXTINF:([0-9.]+)", video_playlist)]
        assert durations, "the media playlist advertises no segments"
        assert max(durations) <= 1.5, durations
        assert sum(durations) == pytest.approx(3.0, abs=0.5)

        # Every URI in every manifest resolves to a packaged file. The pipeline
        # asserts this itself; doing it here too names the check that failed.
        from clipmux_transcoder.pipeline import validate_manifest_references

        validate_manifest_references(output_dir)

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


# ── the media matrix: every reported shape, end to end ───────────────────────

def encode_one(clip: Path, tmp_path: Path, *, max_height: int = 360, fps: float = 25.0):
    """
    Plan and encode the smallest rung of a clip with real FFmpeg, then validate.

    Returns the metadata of the produced file. `validate_encoded_rendition` runs
    against the real output, which is what makes this more than "ffmpeg exited 0".
    """
    from clipmux_transcoder.encoding.validation import validate_encoded_rendition

    metadata = get_video_metadata(str(clip))
    specs = plan_renditions(metadata, policy=POLICY_CAPPED, max_height=max_height)
    assert specs, f"{clip.name} planned no renditions"
    spec = specs[-1]
    output = tmp_path / f"{clip.stem}-{spec.label}.mp4"
    run_ffmpeg(
        build_video_command(
            ffmpeg="ffmpeg", input_path=str(clip), output_path=str(output),
            backend=CPU_BACKEND, spec=spec, metadata=metadata,
            segment_duration=1.0, gpu_decode=False,
        ),
        label=f"matrix-{clip.stem}-{spec.label}",
    )
    validate_encoded_rendition(output, spec, duration=metadata.duration)
    return spec, get_video_metadata(str(output))


MATRIX_CLIPS = (
    "landscape_1080", "portrait", "odd_dims", "sub_360", "silent", "short",
    "hevc_10bit", "hdr10", "av1_opus", "vp9_opus", "yuv422", "yuv444",
    "rotated", "vfr",
)


@requires_ffmpeg
class TestMediaMatrix:
    def test_every_shape_encodes_to_the_planned_dimensions_and_validates(self, clips, tmp_path):
        missing = [name for name in MATRIX_CLIPS if name not in clips]
        if missing:
            pytest.skip(f"local FFmpeg cannot synthesize: {', '.join(missing)}")

        for name in MATRIX_CLIPS:
            spec, encoded = encode_one(clips[name], tmp_path)
            assert (encoded.width, encoded.height) == (spec.width, spec.height), name
            assert encoded.fps > 0, name

    def test_ten_bit_and_wide_chroma_sources_become_8_bit_420(self, clips, tmp_path):
        for name in ("hevc_10bit", "yuv422", "yuv444"):
            if name not in clips:
                pytest.skip(f"local FFmpeg cannot synthesize {name}")
            source = get_video_metadata(str(clips[name]))
            assert source.bit_depth > 8 or source.pixel_format != "yuv420p", name
            _, encoded = encode_one(clips[name], tmp_path)
            assert encoded.pixel_format == "yuv420p", name

    def test_hdr_is_tonemapped_to_sdr(self, clips, tmp_path):
        if "hdr10" not in clips:
            pytest.skip("local FFmpeg cannot synthesize HDR10")
        source = get_video_metadata(str(clips["hdr10"]))
        assert source.is_hdr is True, "the HDR clip must be tagged as HDR to test anything"
        assert source.color_transfer == "smpte2084"

        _, encoded = encode_one(clips["hdr10"], tmp_path)
        assert encoded.pixel_format == "yuv420p"
        # SDR output: the PQ transfer must be gone, not carried through.
        assert encoded.color_transfer not in ("smpte2084", "arib-std-b67")

    def test_a_rotated_source_is_encoded_upright(self, clips, tmp_path):
        if "rotated" not in clips:
            pytest.skip("local FFmpeg cannot synthesize rotated video")
        source = get_video_metadata(str(clips["rotated"]))
        assert source.rotation == 90.0
        # The analyser reports displayed dimensions, so a 1080x608 coding with a
        # 90° rotation is a 608x1080 portrait source.
        assert (source.width, source.height) == (608, 1080)
        assert source.is_vertical is True

        spec, encoded = encode_one(clips["rotated"], tmp_path)
        assert spec.width < spec.height
        assert encoded.width < encoded.height, "the encoded rendition must be upright"
        assert (encoded.width, encoded.height) == (spec.width, spec.height)

    def test_variable_frame_rate_gets_a_constant_output_rate(self, clips, tmp_path):
        if "vfr" not in clips:
            pytest.skip("local FFmpeg cannot synthesize VFR video")
        source = get_video_metadata(str(clips["vfr"]))
        assert source.duration > 0

        spec, encoded = encode_one(clips["vfr"], tmp_path)
        assert encoded.fps == pytest.approx(round(encoded.fps), abs=0.01), (
            "the output must be a constant frame rate"
        )
        assert encoded.fps == pytest.approx(spec.fps, rel=0.02)

    def test_gpu_path_eligibility_follows_the_source_not_the_container(self, clips):
        from clipmux_transcoder.encoding.backends import source_gpu_path_supported

        if "av1_opus" in clips:
            av1 = get_video_metadata(str(clips["av1_opus"]))
            assert av1.codec_name == "av1"
            # AV1/Opus WebM is the reported source shape: software decode with a
            # hardware encode (hybrid), never the GPU filter path.
            assert source_gpu_path_supported(av1) is False
        if "landscape_1080" in clips:
            assert source_gpu_path_supported(get_video_metadata(str(clips["landscape_1080"]))) is True
        if "hevc_10bit" in clips:
            assert source_gpu_path_supported(get_video_metadata(str(clips["hevc_10bit"]))) is False


@requires_packager
class TestMatrixPackaging:
    def _run(self, clip: Path, tmp_path: Path, *, segment_duration: float = 1.0):
        from clipmux_transcoder.pipeline import run_pipeline

        options = ProcessingOptions(
            video_id="matrix",
            attempt_id=f"attempt-{clip.stem}",
            max_height=360,
            rendition_concurrency=1,
            segment_duration=segment_duration,
        )
        return run_pipeline(
            clip, tmp_path / "work", options, detect_capabilities(), None, CancellationToken()
        )

    def test_the_reported_av1_opus_webm_packages_into_playable_hls_and_dash(self, clips, tmp_path):
        if "av1_opus" not in clips:
            pytest.skip("local FFmpeg cannot synthesize AV1/Opus WebM")
        result = self._run(clips["av1_opus"], tmp_path)

        paths = {artifact.path for artifact in result.artifacts}
        assert "playlist.m3u8" in paths and "manifest.mpd" in paths
        assert any(path.startswith("audio/") for path in paths), "Opus audio must survive"
        assert any(path.endswith(".m4s") for path in paths)
        assert result.renditions and result.renditions[0].backend == "cpu"

    def test_a_ten_bit_hdr_source_packages_as_sdr(self, clips, tmp_path):
        if "hdr10" not in clips:
            pytest.skip("local FFmpeg cannot synthesize HDR10")
        result = self._run(clips["hdr10"], tmp_path)
        assert result.metadata.is_hdr is True
        assert any(artifact.path == "playlist.m3u8" for artifact in result.artifacts)

    def test_audio_only_sources_package_without_video_renditions(self, clips, tmp_path):
        result = self._run(clips["audio_only"], tmp_path)
        assert result.renditions == []
        paths = {artifact.path for artifact in result.artifacts}
        assert any(path.startswith("audio/") for path in paths)
        assert "playlist.m3u8" in paths

    def test_segments_align_with_the_encoder_keyframes(self, clips, tmp_path):
        from clipmux_transcoder.pipeline import validate_manifest_references

        result = self._run(clips["landscape_1080"], tmp_path, segment_duration=1.0)
        output_dir = tmp_path / "work" / "output"
        validate_manifest_references(output_dir, result.artifacts)

        video_playlists = [
            path for path in sorted(output_dir.glob("stream_*.m3u8"))
            if "video_" in path.read_text()
        ]
        assert video_playlists, "no video media playlist"
        playlist = video_playlists[0].read_text()
        durations = [float(value) for value in re.findall(r"#EXTINF:([0-9.]+)", playlist)]
        assert len(durations) >= 2, "a 3s clip at 1s segments must be cut more than once"
        assert max(durations) <= 1.5, durations

        # Every segment boundary is a keyframe. A bare `.m4s` has no moov, so
        # each segment is probed glued to the init segment — which is exactly
        # what a player does when it fetches it.
        init = (output_dir / "video_360p" / "init.mp4").read_bytes()
        segments = sorted(output_dir.glob("video_360p/*.m4s"))
        assert segments
        for index, segment in enumerate(segments):
            probe_target = tmp_path / f"segment-{index}.mp4"
            probe_target.write_bytes(init + segment.read_bytes())
            completed = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-select_streams", "v:0",
                    "-show_entries", "frame=key_frame", "-of", "csv=p=0", str(probe_target),
                ],
                capture_output=True, text=True, timeout=60,
            )
            assert completed.returncode == 0, completed.stderr
            flags = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
            assert flags, f"{segment.name} has no frames"
            assert flags[0].startswith("1"), f"{segment.name} does not start on a keyframe"


@requires_packager
class TestThreadBoundsWithRealFfmpeg:
    """
    The thread bounds must be flags FFmpeg *accepts*, in the positions we put them.

    The unit tests assert the flags are present; they cannot assert they take
    effect, and neither can a bare real encode: an option placed after the output
    path is *silently ignored* by FFmpeg rather than rejected (found by
    red-checking this very test). So this class captures the engine's own command
    line, checks the placement, and then lets a real encode prove the placement is
    one FFmpeg executes.
    """

    def _run(self, clip: Path, tmp_path: Path, **overrides):
        from clipmux_transcoder.pipeline import run_pipeline

        options = ProcessingOptions(
            video_id="threads",
            attempt_id=f"attempt-{clip.stem}",
            max_height=360,
            rendition_concurrency=1,
            segment_duration=1.0,
            **overrides,
        )
        return run_pipeline(
            clip, tmp_path / "work", options, detect_capabilities(), None, CancellationToken()
        )

    def test_a_bounded_cpu_run_encodes_and_packages(self, clips, tmp_path, monkeypatch):
        from clipmux_transcoder import pipeline as pipeline_module
        from clipmux_transcoder.pipeline import validate_manifest_references

        # Capture the command the engine really runs, while still running it.
        seen: dict[str, list] = {}
        real_run_ffmpeg = pipeline_module.run_ffmpeg

        def spy(cmd, **kwargs):
            seen.setdefault(kwargs["label"], list(cmd))
            return real_run_ffmpeg(cmd, **kwargs)

        monkeypatch.setattr(pipeline_module, "run_ffmpeg", spy)

        result = self._run(
            clips["landscape_1080"],
            tmp_path,
            cpu_rendition_concurrency=1,
            cpu_ffmpeg_threads=2,
            audio_ffmpeg_threads=1,
        )

        video_cmd = next(
            cmd for label, cmd in seen.items()
            if label.startswith("encode-") and "audio" not in label
        )
        audio_cmd = next(cmd for label, cmd in seen.items() if label == "encode-audio")
        for cmd, flag, expected in (
            (video_cmd, "-threads:v", "2"),
            (audio_cmd, "-threads:a", "1"),
        ):
            assert cmd[cmd.index(flag) + 1] == expected
            # Decoder and filter bounds are input/global options (before `-i`);
            # the encoder bound is an output option — after `-i`, and before the
            # output path. The last part is the one that matters: FFmpeg *ignores*
            # options that follow the output instead of rejecting them, so a bound
            # placed there silently stops bounding anything (red-checked).
            assert cmd.index("-filter_threads") < cmd.index("-i")
            assert cmd.index(flag) > cmd.index("-i")
            assert cmd[-1].endswith(".mp4"), (
                f"options follow the output path ({cmd[-3:]}); FFmpeg ignores them"
            )
            assert cmd.index(flag) < len(cmd) - 1

        paths = {artifact.path for artifact in result.artifacts}
        assert "playlist.m3u8" in paths and "manifest.mpd" in paths
        assert any(path.startswith("video_360p/") for path in paths)
        assert any(path.startswith("audio/") for path in paths)

        # The delivered bytes are still exactly what was planned: a bound that
        # broke the encoder (or silently dropped the output) fails here, not at
        # playtime. The fMP4 intermediates are gone by now — the pipeline deletes
        # them once Shaka has written its segments — so this inspects the packaged
        # stream the way a player does, init segment glued to the first segment.
        output_dir = tmp_path / "work" / "output"
        spec = plan_renditions(
            get_video_metadata(str(clips["landscape_1080"])), policy=POLICY_CAPPED, max_height=360
        )[-1]
        segment = sorted(output_dir.glob(f"video_{spec.label}/*.m4s"))[0]
        player_view = tmp_path / "packaged-first-segment.mp4"
        player_view.write_bytes(
            (output_dir / f"video_{spec.label}" / "init.mp4").read_bytes() + segment.read_bytes()
        )
        probed = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=codec_name,width,height,pix_fmt",
                "-of", "json", str(player_view),
            ],
            capture_output=True, text=True, timeout=60,
        )
        assert probed.returncode == 0, probed.stderr
        stream = json.loads(probed.stdout)["streams"][0]
        assert (stream["codec_name"], stream["width"], stream["height"]) == (
            "h264", spec.width, spec.height,
        )
        assert stream["pix_fmt"] == "yuv420p"
        validate_manifest_references(output_dir, result.artifacts)

    def test_a_bounded_audio_only_run_encodes(self, clips, tmp_path):
        # `-threads:a` is an output-side encoder option; an audio-only job is the
        # shortest path that proves FFmpeg accepts it there.
        result = self._run(
            clips["audio_only"], tmp_path, cpu_ffmpeg_threads=2, audio_ffmpeg_threads=1
        )
        assert result.renditions == []
        assert any(artifact.path.startswith("audio/") for artifact in result.artifacts)

    def test_the_engine_only_adds_thread_flags_when_a_bound_is_set(self, clips, tmp_path):
        """
        Bound placement, on a real command line.

        `0` means "let FFmpeg decide", so the flags must be absent — otherwise a
        machine that never configured a bound silently inherits one.
        """
        from clipmux_transcoder.encoding.backends import (
            CPU_BACKEND,
            RenderSpec,
            build_video_command,
        )
        from clipmux_transcoder.pipeline import encode_threads_for

        metadata = get_video_metadata(str(clips["sub_360"]))
        spec = RenderSpec(
            label="240p", width=320, height=240, bitrate="800k",
            maxrate="1M", bufsize="2M", fps=metadata.fps or 25.0,
        )
        base = build_video_command(
            ffmpeg="ffmpeg", input_path=str(clips["sub_360"]),
            output_path=str(tmp_path / "bounded.mp4"), backend=CPU_BACKEND,
            spec=spec, metadata=metadata, segment_duration=1.0, gpu_decode=False,
        )
        assert "-filter_threads" not in base and "-threads:v" not in base

        unbounded = ProcessingOptions(cpu_ffmpeg_threads=0, ffmpeg_threads=0)
        assert encode_threads_for("cpu", unbounded) == 0

        bounded_options = ProcessingOptions(cpu_ffmpeg_threads=2)
        threads = encode_threads_for("cpu", bounded_options)
        assert threads == 2

        # Rebuild the command exactly as `_encode_rendition` does, then run it.
        cmd = base[:2] + ["-threads", str(threads), "-filter_threads", str(threads)] + base[2:]
        cmd = cmd[:-1] + ["-threads:v", str(threads)] + cmd[-1:]
        run_ffmpeg(cmd, label="thread-bound-shape")
        assert (tmp_path / "bounded.mp4").stat().st_size > 1000
