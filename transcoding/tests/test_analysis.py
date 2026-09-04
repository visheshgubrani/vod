"""Tests for pure ffprobe JSON parsing and typed validation."""
import pytest

from errors import (
    ERROR_EMPTY_FILE,
    ERROR_INVALID_CONTAINER,
    ERROR_INVALID_METADATA,
    TranscodeError,
)
from video.analysis import parse_ffprobe, select_optimal_ladder, VideoMetadata

H264_SAMPLE = {
    "streams": [
        {
            "codec_type": "video",
            "codec_name": "h264",
            "width": 1920,
            "height": 1080,
            "r_frame_rate": "30000/1001",
            "color_transfer": "bt709",
        },
        {"codec_type": "audio", "codec_name": "aac"},
    ],
    "format": {"duration": "120.5"},
}


def make_stream(**overrides):
    stream = {
        "codec_type": "video",
        "codec_name": "h264",
        "width": 1920,
        "height": 1080,
        "r_frame_rate": "25/1",
        "color_transfer": "bt709",
    }
    stream.update(overrides)
    return stream


class TestParseFfprobe:
    def test_standard_landscape(self):
        meta = parse_ffprobe(H264_SAMPLE)
        assert meta.width == 1920
        assert meta.height == 1080
        assert meta.duration == 120.5
        assert meta.fps == pytest.approx(30000 / 1001)
        assert meta.has_video is True
        assert meta.has_audio is True
        assert meta.is_hdr is False
        assert meta.is_vertical is False
        assert meta.rotation == 0.0

    def test_rotated_90_is_treated_as_vertical(self):
        data = {
            "streams": [
                make_stream(
                    width=1920,
                    height=1080,
                    side_data_list=[{"side_data_type": "Display Matrix", "rotation": -90}],
                ),
                {"codec_type": "audio"},
            ],
            "format": {"duration": "10"},
        }
        meta = parse_ffprobe(data)
        assert meta.rotation == -90.0
        assert meta.width == 1080
        assert meta.height == 1920
        assert meta.is_vertical is True

    def test_hdr_detected_from_color_transfer(self):
        for transfer in ("smpte2084", "arib-std-b67"):
            data = {
                "streams": [make_stream(color_transfer=transfer)],
                "format": {"duration": "10"},
            }
            assert parse_ffprobe(data).is_hdr is True

    def test_silent_video_has_no_audio(self):
        data = {"streams": [make_stream()], "format": {"duration": "10"}}
        meta = parse_ffprobe(data)
        assert meta.has_audio is False
        assert meta.has_video is True

    def test_audio_only_input_has_no_video_but_parses(self):
        data = {
            "streams": [{"codec_type": "audio", "codec_name": "aac"}],
            "format": {"duration": "300"},
        }
        meta = parse_ffprobe(data)
        assert meta.has_video is False
        assert meta.has_audio is True

    def test_missing_duration_raises_empty_file(self):
        data = {"streams": [make_stream()], "format": {}}
        with pytest.raises(TranscodeError) as exc:
            parse_ffprobe(data)
        assert exc.value.code == ERROR_EMPTY_FILE

    def test_zero_duration_raises_empty_file(self):
        data = {"streams": [make_stream()], "format": {"duration": "0"}}
        with pytest.raises(TranscodeError) as exc:
            parse_ffprobe(data)
        assert exc.value.code == ERROR_EMPTY_FILE

    def test_no_streams_at_all_raises_invalid_container(self):
        with pytest.raises(TranscodeError) as exc:
            parse_ffprobe({"streams": [], "format": {"duration": "10"}})
        assert exc.value.code == ERROR_INVALID_CONTAINER

    def test_unusable_dimensions_raise_invalid_metadata(self):
        data = {
            "streams": [make_stream(width=0, height=0)],
            "format": {"duration": "10"},
        }
        with pytest.raises(TranscodeError) as exc:
            parse_ffprobe(data)
        assert exc.value.code == ERROR_INVALID_METADATA

    def test_zero_or_absurd_fps_is_sanitized_to_30(self):
        for fps in ("0/1", "0/0", "240/1", "not-a-ratio"):
            data = {"streams": [make_stream(r_frame_rate=fps)], "format": {"duration": "10"}}
            meta = parse_ffprobe(data)
            assert meta.fps == 30.0

    def test_fractional_frame_rate(self):
        data = {
            "streams": [make_stream(r_frame_rate="24000/1001")],
            "format": {"duration": "10"},
        }
        assert parse_ffprobe(data).fps == pytest.approx(24000 / 1001)


class TestLadder:
    def test_no_upscaling_and_vertical_cap(self):
        vertical = VideoMetadata(
            width=1080, height=1920, duration=10, fps=30.0,
            has_audio=True, has_video=True, is_hdr=False, codec_name="h264",
        )
        labels = [p.label for p in select_optimal_ladder(vertical)]
        assert "2160p" not in labels
        assert "1080p" in labels  # height 1080 <= 1920 and <= vertical cap
        assert all(int(p.label.rstrip("p")) <= 1080 for p in select_optimal_ladder(vertical))

    def test_ladder_respects_source_height(self):
        meta = VideoMetadata(
            width=640, height=360, duration=10, fps=30.0,
            has_audio=True, has_video=True, is_hdr=False, codec_name="h264",
        )
        labels = [p.label for p in select_optimal_ladder(meta)]
        assert all(int(p.label.rstrip("p")) <= 360 for p in select_optimal_ladder(meta))
        assert labels  # never empty
