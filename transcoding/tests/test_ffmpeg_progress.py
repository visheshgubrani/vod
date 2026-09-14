"""FFmpeg progress decoding, stall classification and publication ordering."""
import subprocess
import threading
import time

import pytest

from openvod_transcoder.errors import CancelledError, FFmpegProcessError
from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.ffmpeg_progress import (
    FfmpegProgress,
    StallPolicy,
    advance_progress,
    parse_progress_kv,
    parse_timestamp,
    progress_fraction,
    run_ffmpeg,
)
from openvod_transcoder.transfer.base import (
    content_type_for,
    is_playlist,
    order_for_publication,
)


class TestParseTimestamp:
    def test_hours_minutes_seconds(self):
        assert parse_timestamp("01:02:03.5") == pytest.approx(3723.5)

    def test_zero(self):
        assert parse_timestamp("00:00:00.000000") == 0.0

    def test_rejects_junk(self):
        assert parse_timestamp("N/A") is None
        assert parse_timestamp("") is None
        assert parse_timestamp("1:2") is None


class TestParseProgressKv:
    def test_out_time_ms_is_microseconds_despite_its_name(self):
        # The single most consequential detail in this module: reading
        # out_time_ms as milliseconds makes a 10-minute encode look like a week.
        decoded = parse_progress_kv(["out_time_ms=600000000", "progress=continue"])
        assert decoded.out_time_seconds == pytest.approx(600.0)

    def test_prefers_the_correctly_named_field(self):
        decoded = parse_progress_kv([
            "out_time_us=1000000",
            "out_time_ms=999999999",
            "progress=continue",
        ])
        assert decoded.out_time_seconds == pytest.approx(1.0)

    def test_falls_back_to_the_human_timestamp(self):
        decoded = parse_progress_kv(["out_time=00:00:12.500000", "progress=continue"])
        assert decoded.out_time_seconds == pytest.approx(12.5)

    def test_decodes_frame_count_and_speed(self):
        decoded = parse_progress_kv([
            "frame=1200",
            "speed=2.5x",
            "drop_frames=3",
            "progress=continue",
        ])
        assert decoded.frame == 1200
        assert decoded.speed == pytest.approx(2.5)
        assert decoded.dropped_frames == 3

    def test_speed_na_is_not_a_number(self):
        assert parse_progress_kv(["speed=N/A"]).speed is None

    def test_progress_end_marks_completion(self):
        assert parse_progress_kv(["progress=end"]).ended is True
        assert parse_progress_kv(["progress=continue"]).ended is False

    def test_usable_only_when_it_says_something_about_position(self):
        assert parse_progress_kv(["frame=1"]).usable is True
        assert parse_progress_kv(["speed=1x"]).usable is False


class TestProgressFraction:
    def test_mid_encode(self):
        assert progress_fraction(30.0, 120.0) == pytest.approx(0.25)

    def test_clamped_at_one(self):
        assert progress_fraction(200.0, 120.0) == 1.0

    def test_unknown_duration_is_zero_not_a_guess(self):
        assert progress_fraction(30.0, None) == 0.0
        assert progress_fraction(None, 120.0) == 0.0
        assert progress_fraction(30.0, 0) == 0.0


class TestAdvanceProgress:
    """
    What counts as forward progress.

    The watchdog resets only on *movement*. A wedged encoder that keeps
    re-emitting its last position — or an audio muxer whose frame counter is
    stuck — would otherwise hold the stall detector open forever, which is the
    defect this helper exists to close.
    """

    def test_a_larger_timestamp_moves(self):
        moved, best_time, best_frame = advance_progress(-1.0, None, FfmpegProgress(out_time_seconds=5.0))
        assert moved is True
        assert best_time == 5.0

    def test_the_same_timestamp_does_not_move(self):
        moved, best_time, _ = advance_progress(5.0, None, FfmpegProgress(out_time_seconds=5.0))
        assert moved is False
        assert best_time == 5.0

    def test_a_smaller_timestamp_does_not_move(self):
        # Filters that reorder frames legitimately report backwards positions.
        moved, best_time, _ = advance_progress(9.0, None, FfmpegProgress(out_time_seconds=4.0))
        assert moved is False
        assert best_time == 9.0

    def test_a_moving_frame_counter_moves_when_time_does_not(self):
        # Audio-only encodes never advance out_time but do advance frames.
        moved, _, best_frame = advance_progress(None, 120, FfmpegProgress(frame=121))
        assert moved is True
        assert best_frame == 121

    def test_a_repeated_frame_counter_does_not_move(self):
        moved, _, best_frame = advance_progress(None, 120, FfmpegProgress(frame=120))
        assert moved is False
        assert best_frame == 120

    def test_a_block_with_neither_field_does_not_move(self):
        moved, best_time, best_frame = advance_progress(3.0, 30, FfmpegProgress(speed=1.2))
        assert moved is False
        assert (best_time, best_frame) == (3.0, 30)


class TestPublicationOrder:
    def test_playlists_are_published_last(self):
        ordered = order_for_publication(
            ["playlist.m3u8", "video_720p/1.m4s", "manifest.mpd", "video_720p/init.mp4"]
        )
        assert ordered == [
            "video_720p/1.m4s",
            "video_720p/init.mp4",
            "playlist.m3u8",
            "manifest.mpd",
        ]

    def test_order_is_stable_for_non_playlists(self):
        ordered = order_for_publication(["b.m4s", "a.m4s", "c.m4s"])
        assert ordered == ["b.m4s", "a.m4s", "c.m4s"]

    def test_is_playlist_knows_both_manifest_types(self):
        assert is_playlist("playlist.m3u8") is True
        assert is_playlist("video_720p/index.M3U8") is True
        assert is_playlist("manifest.mpd") is True
        assert is_playlist("video_720p/1.m4s") is False


class TestContentTypes:
    def test_playlists_are_short_lived(self):
        assert content_type_for("playlist.m3u8") == (
            "application/vnd.apple.mpegurl",
            "public, max-age=60",
        )

    def test_segments_are_immutable(self):
        content_type, cache_control = content_type_for("video_720p/3.m4s")
        assert content_type == "video/iso.segment"
        assert "immutable" in cache_control

    def test_unknown_extensions_get_a_safe_default(self):
        content_type, _ = content_type_for("weird.xyz")
        assert content_type == "application/octet-stream"


class FakeProcess:
    """Minimal Popen stand-in over a fixed list of progress lines."""

    def __init__(self, lines, returncode=0, stderr="", *, exit_on_eof=True):
        self.returncode = returncode
        self.stderr = _Iterable(stderr.splitlines(keepends=True))
        self.stdout = _Iterable([f"{line}\n" for line in lines], on_eof=lambda: setattr(self, "exited", exit_on_eof))
        self.terminated = False
        # A real process is running until it exits, so `poll()` is None until
        # something terminates it. `run_ffmpeg` checks exactly that before
        # deciding whether terminating is necessary.
        self.exited = False

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return None if not (self.terminated or self.exited) else self.returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


class _Iterable:
    def __init__(self, items, on_eof=lambda: None):
        self._items = items
        self._index = 0
        self._on_eof = on_eof

    def __iter__(self):
        return self

    def __next__(self):
        if self._index >= len(self._items):
            self._on_eof()
            raise StopIteration
        item = self._items[self._index]
        self._index += 1
        return item

    def read(self, *_args):
        return ""


def _patch_popen(monkeypatch, process):
    calls = {}

    def fake_popen(cmd, **kwargs):
        calls["cmd"] = cmd
        calls["kwargs"] = kwargs
        return process

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    return calls


class TestRunFfmpeg:
    def test_appends_progress_pipe_so_callers_cannot_forget_it(self, monkeypatch):
        process = FakeProcess(["frame=1", "out_time_us=1000000", "progress=end"])
        calls = _patch_popen(monkeypatch, process)
        run_ffmpeg(["ffmpeg", "-i", "in.mp4", "out.mp4"], label="x")
        assert calls["cmd"][-3:] == ["-progress", "pipe:1", "-nostats"]

    def test_reports_fraction_from_decoded_blocks(self, monkeypatch):
        process = FakeProcess([
            "out_time_us=30000000",
            "progress=continue",
            "out_time_us=60000000",
            "progress=end",
        ])
        _patch_popen(monkeypatch, process)
        seen = []
        run_ffmpeg(
            ["ffmpeg"],
            label="x",
            duration=120.0,
            on_progress=lambda decoded, fraction: seen.append(fraction),
        )
        # 30s and 60s of a 120s source.
        assert seen == [pytest.approx(0.25), pytest.approx(0.5)]

    def test_non_zero_exit_raises_with_stderr_tail(self, monkeypatch):
        process = FakeProcess(["progress=end"], returncode=1, stderr="boom: bad codec")
        _patch_popen(monkeypatch, process)
        with pytest.raises(FFmpegProcessError, match="boom: bad codec") as caught:
            run_ffmpeg(["ffmpeg"], label="encode-720p")
        assert caught.value.returncode == 1
        assert caught.value.operation == "encode-720p"

    def test_the_reported_scale_cuda_rejection_is_classified_at_the_process_boundary(
        self, monkeypatch
    ):
        """
        The regression that started this work.

        A build whose `scale_cuda` rejects the `format` option exits non-zero
        with this stderr. Raised as a plain RuntimeError it bypassed the
        fallback policy entirely; classified as a filter failure it advances to
        the hybrid path, which does not use that filter.
        """
        from openvod_transcoder.encoding.failures import FAILURE_FILTER
        from openvod_transcoder.errors import is_fallback_eligible

        stderr = (
            "[AVFilterGraph @ 0x55d1] Error initializing filter 'scale_cuda' with args "
            "'1920:1080:format=yuv420p'\n"
            "Error reinitializing filters!\n"
            "Failed to inject frame into filter network: Invalid argument\n"
        )
        process = FakeProcess(["progress=end"], returncode=1, stderr=stderr)
        _patch_popen(monkeypatch, process)
        with pytest.raises(FFmpegProcessError) as caught:
            run_ffmpeg(["ffmpeg"], label="encode-1080p-nvenc")
        assert caught.value.failure_kind == FAILURE_FILTER
        assert is_fallback_eligible(caught.value) is True

    def test_corrupt_media_is_not_fallback_eligible(self, monkeypatch):
        from openvod_transcoder.errors import is_fallback_eligible

        process = FakeProcess(
            ["progress=end"], returncode=1, stderr="Invalid data found when processing input"
        )
        _patch_popen(monkeypatch, process)
        with pytest.raises(FFmpegProcessError) as caught:
            run_ffmpeg(["ffmpeg"], label="encode-720p")
        assert is_fallback_eligible(caught.value) is False

    def test_cancellation_terminates_before_returning(self, monkeypatch):
        token = CancellationToken()
        token.cancel("owner cancelled")
        process = FakeProcess(["out_time_us=1000000", "progress=continue"], exit_on_eof=False)
        _patch_popen(monkeypatch, process)
        with pytest.raises(CancelledError):
            run_ffmpeg(["ffmpeg"], label="x", cancellation=token)
        assert process.terminated is True

    def test_disabled_stall_policy_means_no_stall_checks(self):
        assert StallPolicy(timeout_seconds=0).enabled is False
        assert StallPolicy(timeout_seconds=900).enabled is True


class TestStallError:
    def test_a_stalled_encoder_is_reported_as_stalled_not_failed(self, monkeypatch):
        from openvod_transcoder.errors import ERROR_STALLED
        from openvod_transcoder.ffmpeg_progress import StallError

        process = FakeProcess(["out_time_us=1000000", "progress=continue"], exit_on_eof=False)
        _patch_popen(monkeypatch, process)
        # Injected clock: cheap and deterministic, unlike patching the global
        # `time` module that every other thread in the process also reads.
        ticks = iter([0.0, 0.0, 4000.0, 4000.0, 4000.0])
        with pytest.raises(StallError) as caught:
            run_ffmpeg(
                ["ffmpeg"],
                label="encode-1080p",
                stall=StallPolicy(timeout_seconds=900.0),
                clock=lambda: next(ticks, 4000.0),
            )
        assert caught.value.code == ERROR_STALLED
        assert process.terminated is True


class SilentProcess:
    """
    A subprocess stand-in that never emits progress.

    ``stdout`` blocks until something terminates the process, which is exactly
    the shape that defeated the old implementation: its progress loop waited on
    stdout forever, so cancellation and the stall detector were only evaluated
    when FFmpeg happened to say something.
    """

    def __init__(self, returncode=0):
        self.returncode = returncode
        self.stderr = _Iterable([])
        self.stdout = _BlockingIterable(self)
        self.terminated = False
        self.killed = False

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode if self.terminated else None

    def terminate(self):
        self.terminated = True
        self.stdout.release.set()

    def kill(self):
        self.killed = True
        self.terminated = True
        self.stdout.release.set()


class _BlockingIterable:
    def __init__(self, process):
        self.process = process
        self.release = threading.Event()

    def __iter__(self):
        return self

    def __next__(self):
        # Bounded so a bug in the watchdog fails the test instead of hanging it.
        self.release.wait(timeout=10)
        raise StopIteration

    def read(self, *_args):
        return ""


class TestWatchdogIsIndependentOfStdout:
    def test_a_silent_process_is_terminated_by_the_stall_watchdog(self, monkeypatch):
        from openvod_transcoder.ffmpeg_progress import StallError

        process = SilentProcess()
        _patch_popen(monkeypatch, process)
        started = time.monotonic()
        with pytest.raises(StallError):
            run_ffmpeg(
                ["ffmpeg"],
                label="encode-silent",
                stall=StallPolicy(timeout_seconds=0.2),
            )
        assert time.monotonic() - started < 5
        assert process.terminated is True

    def test_a_silent_process_is_terminated_when_cancelled(self, monkeypatch):
        process = SilentProcess()
        _patch_popen(monkeypatch, process)
        token = CancellationToken()

        outcome = {}

        def _run():
            try:
                run_ffmpeg(
                    ["ffmpeg"],
                    label="encode-silent",
                    cancellation=token,
                    stall=StallPolicy(timeout_seconds=0),
                )
            except BaseException as exc:  # noqa: BLE001 — recorded for the assertion
                outcome["error"] = exc

        worker = threading.Thread(target=_run, daemon=True)
        worker.start()
        # Cancel *after* the process is running: a pre-cancelled token only
        # proves the entry check works, not that a live process is interrupted.
        time.sleep(0.3)
        token.cancel("owner cancelled")
        worker.join(timeout=10)

        assert not worker.is_alive(), "cancellation did not interrupt a silent process"
        assert isinstance(outcome.get("error"), CancelledError)
        assert process.terminated is True
        assert process.killed is False, "a cooperative terminate must be tried first"


class TestFfmpegProgressShape:
    def test_defaults_are_empty(self):
        decoded = FfmpegProgress()
        assert decoded.out_time_seconds is None
        assert decoded.ended is False
        assert decoded.usable is False
