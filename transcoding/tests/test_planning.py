"""Rendition planning: dimension fitting, ladder selection, audio track choice.

Expected values are worked examples, not re-derived: the fits below are the ones
a person would compute by hand from the stated source and rung.
"""
from openvod_transcoder.config import ENCODING_PROFILES, EncodingProfile
from openvod_transcoder.encoding.backends import even, fit_dimensions
from openvod_transcoder.options import ProcessingOptions
from openvod_transcoder.planning import (
    POLICY_CAPPED,
    POLICY_LEGACY,
    plan_audio,
    plan_renditions,
)
from openvod_transcoder.video.analysis import VideoMetadata


def meta(width, height, **overrides):
    base = dict(
        width=width,
        height=height,
        duration=120.0,
        fps=30.0,
        has_audio=True,
        has_video=True,
        is_hdr=False,
        codec_name="h264",
    )
    base.update(overrides)
    return VideoMetadata(**base)


class TestEven:
    def test_rounds_to_nearest_even(self):
        assert even(1081) == 1080
        assert even(1080) == 1080
        assert even(1079) == 1078
        assert even(1) == 2
        assert even(0) == 2


class TestFitDimensions:
    def test_1080p_source_to_720p_rung(self):
        # 1920x1080 -> 720p: 1080/720 = 1.5, so 1920/1.5 = 1280.
        assert fit_dimensions(1920, 1080, 720) == (1280, 720)

    def test_portrait_source_preserves_ratio(self):
        # 1080x1920 -> 720 height: width 1080 * (720/1920) = 405 -> 404 (even).
        assert fit_dimensions(1080, 1920, 720) == (404, 720)

    def test_never_upscales_a_smaller_source(self):
        assert fit_dimensions(320, 240, 360) == (320, 240)
        assert fit_dimensions(320, 240, 1080) == (320, 240)

    def test_odd_source_dimensions_become_even(self):
        assert fit_dimensions(641, 481, 480) == (640, 480)
        assert fit_dimensions(641, 481, 1080) == (640, 480)

    def test_audio_only_has_nothing_to_scale(self):
        assert fit_dimensions(0, 0, 720) == (0, 0)


class TestPlanRenditions:
    def test_1080p_source_gets_capped_adaptive_ladder(self):
        specs = plan_renditions(meta(1920, 1080), policy=POLICY_CAPPED)
        assert [spec.label for spec in specs] == ["1080p", "720p", "480p", "360p"]
        assert [(spec.width, spec.height) for spec in specs] == [
            (1920, 1080),
            (1280, 720),
            (852, 480),  # 1920 * 480/1080 = 853.3 -> nearest even
            (640, 360),
        ]

    def test_4k_source_is_capped_at_1080p_by_default(self):
        specs = plan_renditions(meta(3840, 2160), policy=POLICY_CAPPED)
        assert [spec.height for spec in specs] == [1080, 720, 480, 360]

    def test_1440p_and_2160p_are_explicit_options(self):
        specs = plan_renditions(
            meta(3840, 2160), policy=POLICY_CAPPED, include_heights=(1440, 2160)
        )
        assert [spec.height for spec in specs] == [2160, 1440, 1080, 720, 480, 360]

    def test_source_below_smallest_rung_is_encoded_at_its_own_size(self):
        specs = plan_renditions(meta(320, 240), policy=POLICY_CAPPED)
        assert len(specs) == 1
        spec = specs[0]
        assert (spec.width, spec.height) == (320, 240)
        # Bitrate scaled down from the 360p rung's 800k by pixel area
        # (76800/230400 = 1/3 -> 267k) and then floored at the 300k minimum,
        # because below that the encoder's rate control stops being meaningful.
        assert spec.bitrate == "300k"
        assert spec.maxrate == "375k"
        assert spec.bufsize == "600k"

    def test_legacy_policy_still_upscales_to_360p(self):
        # The Modal path keeps its historical behaviour byte-for-byte; that is
        # what makes the engine extraction reviewable.
        specs = plan_renditions(meta(320, 240), policy=POLICY_LEGACY)
        assert [spec.label for spec in specs] == ["360p"]
        assert (specs[0].width, specs[0].height) == (320, 240)

    def test_legacy_policy_keeps_2160p_for_a_4k_source(self):
        specs = plan_renditions(meta(3840, 2160), policy=POLICY_LEGACY)
        assert [spec.label for spec in specs] == ["2160p", "1440p", "1080p", "720p", "480p", "360p"]

    def test_portrait_is_capped_to_mobile_friendly_heights(self):
        specs = plan_renditions(meta(1080, 1920), policy=POLICY_CAPPED)
        assert [spec.label for spec in specs] == ["1080p", "720p", "480p", "360p"]
        assert all(spec.width < spec.height for spec in specs)

    def test_audio_only_plans_no_renditions(self):
        specs = plan_renditions(meta(0, 0, has_video=False), policy=POLICY_CAPPED)
        assert specs == []

    def test_frame_rate_is_carried_onto_every_rung(self):
        specs = plan_renditions(meta(1920, 1080, fps=23.976), policy=POLICY_CAPPED)
        assert {spec.fps for spec in specs} == {23.976}

    def test_explicit_fps_override_wins(self):
        specs = plan_renditions(meta(1920, 1080), policy=POLICY_CAPPED, fps=25.0)
        assert {spec.fps for spec in specs} == {25.0}


class TestPlanAudio:
    def test_prefers_the_default_disposition_track(self):
        plan = plan_audio([
            {"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2,
             "tags": {"language": "eng"}},
            {"index": 2, "codec_type": "audio", "codec_name": "aac", "channels": 6,
             "disposition": {"default": 1}, "tags": {"language": "fra"}},
        ])
        assert (plan.stream_index, plan.language, plan.channels) == (2, "fra", 6)

    def test_falls_back_to_the_first_usable_track(self):
        plan = plan_audio([
            {"index": 0, "codec_type": "video", "codec_name": "h264"},
            {"index": 1, "codec_type": "audio", "codec_name": "", "channels": 2},
            {"index": 2, "codec_type": "audio", "codec_name": "opus", "channels": 1},
        ])
        assert plan.stream_index == 2
        assert plan.is_stereo is False

    def test_no_audio_streams_yields_no_plan(self):
        assert plan_audio([{"index": 0, "codec_type": "video", "codec_name": "h264"}]) is None
        assert plan_audio([]) is None


class TestLadderTable:
    def test_the_ladder_table_is_the_source_of_truth_for_bitrates(self):
        by_height = {profile.height: profile for profile in ENCODING_PROFILES}
        assert by_height[1080].bitrate == "5M"
        assert by_height[720].maxrate == "3.5M"
        assert by_height[360].bufsize == "2M"


class TestWireOptionMapping:
    """
    The API stores camelCase; the engine uses snake_case.

    Without an explicit mapping the two vocabularies silently disagreed: a job
    queued with `generateSubtitle: true` ran with subtitles off, because the key
    matched no field and unknown keys are dropped by design. Nothing reported the
    loss, which is the worst property a settings bug can have.
    """

    def test_camel_case_enrichment_flags_are_honoured(self):
        options = ProcessingOptions.from_dict(
            {"generateSubtitle": True, "generateChapters": True}
        )
        assert options.generate_subtitle is True
        assert options.generate_chapters is True

    def test_camel_case_ladder_options_are_honoured(self):
        options = ProcessingOptions.from_dict(
            {"maxHeight": 720, "includeHeights": [1440, 2160]}
        )
        assert options.max_height == 720
        assert options.resolved_heights() == (1440, 2160)

    def test_camel_case_playback_policy_is_honoured(self):
        assert ProcessingOptions.from_dict({"playbackPolicy": "signed"}).playback_policy == "signed"

    def test_snake_case_still_works(self):
        options = ProcessingOptions.from_dict({"generate_subtitle": True, "max_height": 480})
        assert options.generate_subtitle is True
        assert options.max_height == 480

    def test_snake_case_wins_when_both_are_present(self):
        # The engine's own field names are the more specific statement of intent.
        options = ProcessingOptions.from_dict({"maxHeight": 720, "max_height": 480})
        assert options.max_height == 480

    def test_unknown_keys_are_still_dropped(self):
        options = ProcessingOptions.from_dict({"futureOption": True, "maxHeight": 720})
        assert options.max_height == 720

    def test_a_fingerprint_changes_when_a_wire_option_changes(self):
        # Proof the mapping reaches the identity of the work, not just the parse.
        base = ProcessingOptions.from_dict({})
        subtitled = ProcessingOptions.from_dict({"generateSubtitle": True})
        assert base.plan_fingerprint() != subtitled.plan_fingerprint()


class TestAgentLimits:
    """
    The job decides what was asked for; the machine decides what it will spend.
    """

    class _Config:
        encoder_backend = "vaapi"
        encoder_device = "/dev/dri/renderD128"
        capacity_renditions = 1
        upload_concurrency = 2
        stall_timeout_seconds = 300.0
        whisper_model = "small"
        transcribe_language = "en"
        scratch_quota_bytes = 10 * 1024**3

    def test_an_auto_backend_is_replaced_by_the_operators_choice(self):
        from openvod_transcoder.options import ProcessingOptions

        options = ProcessingOptions(encoder_backend="auto").with_agent_limits(self._Config())
        assert options.encoder_backend == "vaapi"
        assert options.encoder_device == "/dev/dri/renderD128"

    def test_an_explicit_job_backend_is_not_rewritten(self):
        # A job that asked for NVENC on a CPU-configured machine is a mismatch
        # for encoder selection to report, not something to silently change.
        from openvod_transcoder.options import ProcessingOptions

        options = ProcessingOptions(encoder_backend="nvenc").with_agent_limits(self._Config())
        assert options.encoder_backend == "nvenc"

    def test_machine_resource_bounds_win(self):
        from openvod_transcoder.options import ProcessingOptions

        options = ProcessingOptions(
            rendition_concurrency=8, upload_concurrency=32
        ).with_agent_limits(self._Config())
        assert options.rendition_concurrency == 1
        assert options.upload_concurrency == 2
        assert options.stall_timeout_seconds == 300.0

    def test_a_machines_own_capacity_raises_a_smaller_job_request(self):
        from openvod_transcoder.options import ProcessingOptions

        class Wide(self._Config):
            capacity_renditions = 4
            upload_concurrency = 16

        options = ProcessingOptions(
            rendition_concurrency=2, upload_concurrency=4
        ).with_agent_limits(Wide())
        assert options.rendition_concurrency == 2
        assert options.upload_concurrency == 4

    def test_transcription_settings_come_from_the_machine(self):
        from openvod_transcoder.options import ProcessingOptions

        options = ProcessingOptions(whisper_model="").with_agent_limits(self._Config())
        assert options.whisper_model == "small"
        assert options.transcribe_language == "en"


class TestRotatedSources:
    """
    A display matrix is part of the picture, not a detail.

    A clip coded 1920x1080 with a 90° rotation *displays* as 1080x1920. The
    analyser applies the rotation when it reads the metadata, so planning sees
    the dimensions FFmpeg's filter graph will see — planning from the coded size
    would fit a portrait video into a landscape rendition and the scaler would
    then stretch the upright frame into it.
    """

    def test_a_quarter_turn_is_reported_as_such(self):
        assert meta(1080, 1920, rotation=90).is_quarter_turned is True
        assert meta(1080, 1920, rotation=270).is_quarter_turned is True
        assert meta(1920, 1080, rotation=180).is_quarter_turned is False
        assert meta(1920, 1080).is_quarter_turned is False

    def test_a_rotated_source_is_planned_at_its_displayed_dimensions(self):
        # What `parse_ffprobe` produces for a 1920x1080 source rotated 90°.
        specs = plan_renditions(meta(1080, 1920, rotation=90), policy=POLICY_CAPPED)
        assert specs, "a rotated 1080p source must still plan renditions"
        for spec in specs:
            assert spec.width < spec.height, spec

    def test_a_rotated_source_uses_the_displayed_height_for_the_cap(self):
        specs = plan_renditions(meta(1080, 1920, rotation=90), policy=POLICY_CAPPED)
        assert max(spec.height for spec in specs) == 1080

    def test_a_rotated_sub_rung_source_is_sized_by_its_display(self):
        # Displayed 180x320: below the 360p rung, so it gets one source-sized
        # rendition at its displayed size rather than an upscaled rung.
        specs = plan_renditions(meta(180, 320, rotation=90), policy=POLICY_CAPPED)
        assert len(specs) == 1
        assert (specs[0].width, specs[0].height) == (180, 320)

    def test_a_rotated_source_never_takes_the_gpu_filter_path(self):
        from openvod_transcoder.encoding.backends import source_gpu_path_supported

        # Hardware frames cannot be rotated, so every rotation — a quarter turn
        # or a half turn — takes the software path; the filter chain has to run
        # the autorotation, and the CUDA/VAAPI scalers cannot consume its output.
        assert source_gpu_path_supported(meta(1080, 1920, rotation=90)) is False
        assert source_gpu_path_supported(meta(1920, 1080, rotation=180)) is False
        assert source_gpu_path_supported(meta(1920, 1080, rotation=0)) is True
