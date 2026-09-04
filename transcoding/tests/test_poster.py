"""Tests for poster seek-time selection."""
from video.poster import choose_poster_time


class TestChoosePosterTime:
    def test_long_videos_use_10_percent_clamped(self):
        assert choose_poster_time(60) == 6.0
        assert choose_poster_time(100) == 10.0
        assert choose_poster_time(10) == 1.0

    def test_short_clips_stay_inside_the_duration(self):
        assert choose_poster_time(2) == 0.5
        assert choose_poster_time(0.5) == 0.125
        assert choose_poster_time(0.2) == 0.1  # floor at 0.1s, still inside

    def test_tiny_clips_never_seek_past_the_end(self):
        ts = choose_poster_time(0.05)
        assert ts <= 0.05
        assert ts >= 0.05

    def test_invalid_duration_returns_safe_default(self):
        assert choose_poster_time(0) == 0.1
        assert choose_poster_time(-5) == 0.1
