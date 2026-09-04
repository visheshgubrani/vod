"""Tests for packager segment duration and upload stats."""
from packaging.shaka import choose_segment_duration
from utils.storage import UploadStats


class TestChooseSegmentDuration:
    def test_standard_content_keeps_4s_segments(self):
        assert choose_segment_duration(120) == 4.0
        assert choose_segment_duration(8) == 4.0

    def test_short_clips_halve_segment_duration(self):
        assert choose_segment_duration(6) == 3.0
        assert choose_segment_duration(3) == 1.5

    def test_one_second_floor_for_short_content(self):
        assert choose_segment_duration(1.5) == 1.0

    def test_subsecond_clips_get_fractional_segments(self):
        assert choose_segment_duration(0.6) == 0.3
        assert choose_segment_duration(0.3) == 0.15

    def test_unknown_duration_falls_back_to_standard(self):
        assert choose_segment_duration(0) == 4.0
        assert choose_segment_duration(-1) == 4.0


class TestUploadStats:
    def test_complete_only_when_all_files_landed(self):
        assert UploadStats(total=5, uploaded=5).complete is True
        assert UploadStats(total=5, uploaded=4).complete is False
        assert UploadStats(total=5, uploaded=5, failed=["a.mp4"]).complete is False
