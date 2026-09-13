"""Progress weighting and per-rendition aggregation."""
import pytest

from openvod_transcoder.progress import (
    STAGE_ANALYZE,
    STAGE_PACKAGE,
    STAGE_SNAPSHOT,
    STAGE_TRANSCODE,
    STAGE_UPLOAD,
    CallbackProgress,
    NullProgress,
    ProgressUpdate,
    RenditionProgress,
    overall_progress,
)


class TestOverallProgress:
    def test_zero_at_the_start_of_the_first_stage(self):
        assert overall_progress(STAGE_SNAPSHOT, 0.0) == 0.0

    def test_stage_end_equals_the_sum_of_prior_weights(self):
        # snapshot 0.02 + download 0.08 + analyze 0.02 = 0.12
        assert overall_progress(STAGE_TRANSCODE, 0.0) == pytest.approx(0.12)

    def test_halfway_through_transcode(self):
        # 0.12 + 0.60 * 0.5 = 0.42
        assert overall_progress(STAGE_TRANSCODE, 0.5) == pytest.approx(0.42)

    def test_upload_is_almost_complete_at_its_start(self):
        # package ends at 0.82, verify at 0.85
        assert overall_progress(STAGE_UPLOAD, 0.0) == pytest.approx(0.85)

    def test_end_of_upload_is_one(self):
        assert overall_progress(STAGE_UPLOAD, 1.0) == 1.0

    def test_fractions_are_clamped_not_trusted(self):
        assert overall_progress(STAGE_ANALYZE, 5.0) == pytest.approx(0.12)
        assert overall_progress(STAGE_ANALYZE, -3.0) == pytest.approx(0.10)

    def test_unknown_stage_is_a_programming_error_not_a_silent_zero(self):
        with pytest.raises(ValueError, match="unknown stage"):
            overall_progress("transcoding", 0.5)


class TestProgressUpdate:
    def test_payload_carries_the_derived_overall_value(self):
        update = ProgressUpdate(stage=STAGE_PACKAGE, fraction=0.5)
        assert update.as_payload() == {"stage": "package", "progress": pytest.approx(0.77)}

    def test_per_rendition_progress_is_reported_sorted(self):
        update = ProgressUpdate(
            stage=STAGE_TRANSCODE,
            fraction=0.5,
            renditions={"720p": 0.75, "1080p": 0.25},
        )
        assert update.as_payload()["renditions"] == {"1080p": 0.25, "720p": 0.75}

    def test_empty_optional_fields_are_omitted(self):
        payload = ProgressUpdate(stage=STAGE_ANALYZE, fraction=1.0).as_payload()
        assert set(payload) == {"stage", "progress"}


class RecordingSink:
    def __init__(self):
        self.updates = []

    def report(self, update):
        self.updates.append(update)


class TestRenditionProgress:
    def test_single_rendition_maps_directly_to_its_fraction(self):
        sink = RecordingSink()
        tracker = RenditionProgress(sink, {"1080p": 1.0})
        tracker.update("1080p", 0.5)
        assert sink.updates[-1].fraction == pytest.approx(0.5)

    def test_two_renditions_are_weighted_by_their_planned_size(self):
        sink = RecordingSink()
        # 1080p is worth three times 360p, so a finished 360p alone is 25%.
        tracker = RenditionProgress(sink, {"1080p": 3.0, "360p": 1.0})
        tracker.complete("360p")
        assert sink.updates[-1].fraction == pytest.approx(0.25)

    def test_completion_of_both_reaches_one(self):
        sink = RecordingSink()
        tracker = RenditionProgress(sink, {"1080p": 3.0, "360p": 1.0})
        tracker.complete("360p")
        tracker.complete("1080p")
        assert sink.updates[-1].fraction == pytest.approx(1.0)

    def test_a_failed_rendition_still_lets_the_aggregate_reach_one(self):
        sink = RecordingSink()
        tracker = RenditionProgress(sink, {"1080p": 1.0, "720p": 1.0})
        tracker.complete("1080p")
        tracker.failed("720p")
        assert sink.updates[-1].fraction == pytest.approx(1.0)

    def test_unplanned_rendition_does_not_inflate_the_aggregate(self):
        sink = RecordingSink()
        tracker = RenditionProgress(sink, {"1080p": 1.0})
        before = tracker.last_activity
        tracker.update("surprise", 1.0)
        # It is not part of the plan, so it is worth no share of the bar...
        assert sink.updates[-1].fraction == pytest.approx(0.0)
        # ...but it IS evidence the encoder is alive, so the stall detector must
        # not fire while a fallback path is producing frames.
        assert tracker.last_activity > before

    def test_forward_movement_advances_the_activity_clock(self):
        sink = RecordingSink()
        tracker = RenditionProgress(sink, {"1080p": 1.0})
        before = tracker.last_activity
        tracker.update("1080p", 0.5)
        assert tracker.last_activity > before

    def test_repeated_identical_reports_do_not_count_as_progress(self):
        # The stall detector keys on this: a wedged encoder that keeps emitting
        # the same position must not look alive.
        sink = RecordingSink()
        tracker = RenditionProgress(sink, {"1080p": 1.0})
        tracker.update("1080p", 0.5)
        marker = tracker.last_activity
        tracker.update("1080p", 0.5)
        assert tracker.last_activity == marker

    def test_speed_is_reported_but_never_drives_activity(self):
        sink = RecordingSink()
        tracker = RenditionProgress(sink, {"1080p": 1.0})
        tracker.update("1080p", 0.5, speed=0.05)
        marker = tracker.last_activity
        tracker.update("1080p", 0.5, speed=9.9)
        assert tracker.last_activity == marker
        assert sink.updates[-1].speed == pytest.approx(9.9)


class TestSinks:
    def test_null_sink_swallows_everything(self):
        assert NullProgress().report(ProgressUpdate(stage=STAGE_UPLOAD)) is None

    def test_callback_sink_forwards_updates(self):
        seen = []
        sink = CallbackProgress(seen.append)
        update = ProgressUpdate(stage=STAGE_ANALYZE, fraction=1.0)
        sink.report(update)
        assert seen == [update]
