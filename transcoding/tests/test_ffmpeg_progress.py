"""FFmpeg progress decoding, stall classification and publication ordering."""
import subprocess

import pytest

from openvod_transcoder.errors import CancelledError
from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.ffmpeg_progress import (
    FfmpegProgress,
    StallPolicy,
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

    def __init__(self, lines, returncode=0, stderr=""):
        self.returncode = returncode
        self.stderr = _Iterable(stderr.splitlines(keepends=True))
        self.stdout = _Iterable([f"{line}\n" for line in lines])
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
    def __init__(self, items):
        self._items = items
        self._index = 0

    def __iter__(self):
        return self

    def __next__(self):
        if self._index >= len(self._items):
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
        with pytest.raises(RuntimeError, match="boom: bad codec"):
            run_ffmpeg(["ffmpeg"], label="encode-720p")

    def test_cancellation_terminates_before_returning(self, monkeypatch):
        token = CancellationToken()
        token.cancel("owner cancelled")
        process = FakeProcess(["out_time_us=1000000", "progress=continue"])
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

        process = FakeProcess(["out_time_us=1000000", "progress=continue"])
        _patch_popen(monkeypatch, process)
        # Monotonic calls in order: `started`, `last_activity`, then one per
        # progress line. The encoder's own position never advances, so the
        # second check sees a 4000s gap against a 900s window.
        clock = iter([0.0, 0.0, 0.0, 4000.0, 4000.0, 4000.0])
        monkeypatch.setattr(
            "openvod_transcoder.ffmpeg_progress.time.monotonic",
            lambda: next(clock, 4000.0),
        )
        with pytest.raises(StallError) as caught:
            run_ffmpeg(
                ["ffmpeg"],
                label="encode-1080p",
                stall=StallPolicy(timeout_seconds=900.0),
            )
        assert caught.value.code == ERROR_STALLED
        assert process.terminated is True


class TestFfmpegProgressShape:
    def test_defaults_are_empty(self):
        decoded = FfmpegProgress()
        assert decoded.out_time_seconds is None
        assert decoded.ended is False
        assert decoded.usable is False
