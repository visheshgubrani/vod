"""FFmpeg failure classification: what may fall back, and what may not.

Every string in this file is copied from real FFmpeg output (or from the report
that triggered this work) rather than invented. The classification is the whole
reason the encoder fallback chain works at all: before it existed, an FFmpeg
non-zero exit surfaced as a bare `RuntimeError`, `is_fallback_eligible` said no,
and a GPU that could not initialise `scale_cuda` failed the job instead of
retrying without it.
"""
import pytest

from clipmux_transcoder.encoding.failures import (
    FAILURE_DECODE,
    FAILURE_DEVICE,
    FAILURE_DISK,
    FAILURE_ENCODER,
    FAILURE_FILTER,
    FAILURE_INPUT,
    FAILURE_MEDIA,
    FAILURE_SESSION,
    FAILURE_UNKNOWN,
    build_process_error,
    classify_ffmpeg_stderr,
    error_code_for_failure_kind,
    is_fallback_eligible_kind,
    marks_backend_unusable,
)
from clipmux_transcoder.errors import (
    ERROR_ENCODER_FAILED,
    ERROR_INSUFFICIENT_DISK,
    ERROR_SOURCE_MISSING,
    ERROR_TRANSCODE_FAILED,
    FALLBACK_ELIGIBLE_CODES,
    FFmpegProcessError,
    is_fallback_eligible,
)

# The stderr from the deployment that started this work: FFmpeg rejects
# `scale_cuda`'s `format` option, so the full-GPU path dies in the filter graph.
SCALE_CUDA_FORMAT_STDERR = """
[AVFilterGraph @ 0x55d1] Error initializing filter 'scale_cuda' with args '1920:1080:format=yuv420p'
Error reinitializing filters!
Failed to inject frame into filter network: Invalid argument
Error while processing the decoded data for stream #0:0
"""


class TestClassifyFfmpegStderr:
    def test_the_reported_scale_cuda_error_is_a_filter_failure(self):
        assert classify_ffmpeg_stderr(SCALE_CUDA_FORMAT_STDERR) == FAILURE_FILTER

    def test_a_missing_filter_option_is_a_filter_failure(self):
        assert classify_ffmpeg_stderr(
            "[AVFilterGraph @ 0x1] Option 'format' not found."
        ) == FAILURE_FILTER

    def test_an_unknown_filter_is_a_filter_failure(self):
        assert classify_ffmpeg_stderr("No such filter: 'scale_cuda'") == FAILURE_FILTER

    def test_software_to_hardware_conversion_error_is_a_filter_failure(self):
        assert classify_ffmpeg_stderr(
            "Impossible to convert between the formats supported by the filter "
            "'graph 0 input from stream 0:0' and the filter 'auto_scale_0'"
        ) == FAILURE_FILTER

    def test_missing_render_device_is_a_device_failure(self):
        assert classify_ffmpeg_stderr(
            "[AVHWDeviceContext @ 0x2] Cannot open device /dev/dri/renderD128"
        ) == FAILURE_DEVICE

    def test_vaapi_initialisation_failure_is_a_device_failure(self):
        assert classify_ffmpeg_stderr(
            "Failed to initialise VAAPI connection: -1 (unknown libva error)."
        ) == FAILURE_DEVICE

    def test_missing_nvidia_driver_is_a_device_failure(self):
        assert classify_ffmpeg_stderr(
            "[AVHWDeviceContext @ 0x3] Cannot load libcuda.so.1"
        ) == FAILURE_DEVICE

    def test_session_exhaustion_is_transient_and_its_own_kind(self):
        # The right response is to serialize and retry the same backend, not to
        # re-encode the job on the CPU.
        assert classify_ffmpeg_stderr(
            "[h264_nvenc @ 0x4] OpenEncodeSessionEx failed: out of memory (10)"
        ) == FAILURE_SESSION
        assert classify_ffmpeg_stderr(
            "[h264_nvenc @ 0x4] No free encoding session available"
        ) == FAILURE_SESSION

    def test_a_broken_encoder_is_the_encoder_kind(self):
        assert classify_ffmpeg_stderr(
            "Unknown encoder 'h264_nvenc'"
        ) == FAILURE_ENCODER

    def test_undecodable_media_is_not_fallback_eligible(self):
        # Re-running corrupt media on another encoder produces the same failure.
        assert classify_ffmpeg_stderr(
            "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5] moov atom not found"
        ) == FAILURE_MEDIA
        assert classify_ffmpeg_stderr(
            "Invalid data found when processing input"
        ) == FAILURE_MEDIA

    def test_a_missing_source_is_an_input_failure(self):
        assert classify_ffmpeg_stderr(
            "in.mp4: No such file or directory"
        ) == FAILURE_INPUT

    def test_disk_exhaustion_is_its_own_kind(self):
        assert classify_ffmpeg_stderr(
            "av_interleaved_write_frame(): No space left on device"
        ) == FAILURE_DISK

    def test_a_hardware_decode_failure_is_the_decode_kind(self):
        assert classify_ffmpeg_stderr(
            "[h264 @ 0x6] Failed to setup hardware decoder for stream #0:0"
        ) == FAILURE_DECODE

    def test_empty_stderr_is_unknown_not_an_encoder_failure(self):
        # An unknown failure must not be blamed on the encoder: that is how a
        # jobs' real error gets buried under a pointless CPU re-encode.
        assert classify_ffmpeg_stderr("") == FAILURE_UNKNOWN
        assert classify_ffmpeg_stderr("Conversion failed!") == FAILURE_UNKNOWN


class TestFallbackEligibility:
    def test_hardware_path_failures_may_fall_back(self):
        for kind in (FAILURE_SESSION, FAILURE_DEVICE, FAILURE_DECODE, FAILURE_FILTER, FAILURE_ENCODER):
            assert is_fallback_eligible_kind(kind) is True, kind

    def test_media_input_disk_and_unknown_failures_may_not(self):
        for kind in (FAILURE_MEDIA, FAILURE_INPUT, FAILURE_DISK, FAILURE_UNKNOWN):
            assert is_fallback_eligible_kind(kind) is False, kind

    def test_proven_unavailability_is_what_skips_a_backend_entirely(self):
        # A filter failure is *this source* hitting a broken filter option; the
        # encoder itself is fine, so the hybrid path must still be tried.
        assert marks_backend_unusable(FAILURE_DEVICE) is True
        assert marks_backend_unusable(FAILURE_ENCODER) is True
        assert marks_backend_unusable(FAILURE_FILTER) is False
        assert marks_backend_unusable(FAILURE_DECODE) is False
        assert marks_backend_unusable(FAILURE_SESSION) is False


class TestErrorCodes:
    def test_hardware_kinds_report_the_encoder_code(self):
        for kind in (FAILURE_SESSION, FAILURE_DEVICE, FAILURE_DECODE, FAILURE_FILTER, FAILURE_ENCODER):
            assert error_code_for_failure_kind(kind) == ERROR_ENCODER_FAILED, kind

    def test_media_failures_stay_out_of_the_fallback_family(self):
        code = error_code_for_failure_kind(FAILURE_MEDIA)
        assert code == ERROR_TRANSCODE_FAILED
        assert code not in FALLBACK_ELIGIBLE_CODES

    def test_input_and_disk_failures_map_to_their_existing_codes(self):
        assert error_code_for_failure_kind(FAILURE_INPUT) == ERROR_SOURCE_MISSING
        assert error_code_for_failure_kind(FAILURE_DISK) == ERROR_INSUFFICIENT_DISK
        assert ERROR_INSUFFICIENT_DISK not in FALLBACK_ELIGIBLE_CODES

    def test_unknown_is_not_fallback_eligible(self):
        assert error_code_for_failure_kind(FAILURE_UNKNOWN) == ERROR_TRANSCODE_FAILED


class TestFfmpegProcessError:
    def test_carries_status_bounded_stderr_and_operation_context(self):
        stderr = "\n".join(f"line {index}" for index in range(400))
        error = build_process_error(
            stderr=stderr,
            returncode=1,
            operation="encode-1080p-nvenc",
        )
        assert error.returncode == 1
        assert error.operation == "encode-1080p-nvenc"
        # An unrecognised failure is not blamed on the encoder.
        assert error.failure_kind == FAILURE_UNKNOWN
        assert error.code == ERROR_TRANSCODE_FAILED
        # Bounded: a 400-line stderr must not travel into the callback payload.
        assert len(error.stderr.splitlines()) <= 50
        assert "line 399" in error.stderr

    def test_a_recognised_failure_gets_the_encoder_code_and_kind(self):
        error = build_process_error(
            stderr=SCALE_CUDA_FORMAT_STDERR,
            returncode=1,
            operation="encode-1080p-nvenc",
        )
        assert error.failure_kind == FAILURE_FILTER
        assert error.code == ERROR_ENCODER_FAILED

    def test_media_failures_are_not_fallback_eligible_even_as_process_errors(self):
        error = build_process_error(
            stderr="Invalid data found when processing input",
            returncode=1,
            operation="encode-360p-cpu",
        )
        assert error.failure_kind == FAILURE_MEDIA
        assert error.code == ERROR_TRANSCODE_FAILED
        assert is_fallback_eligible(error) is False

    def test_encoder_path_failures_are_fallback_eligible(self):
        error = build_process_error(
            stderr=SCALE_CUDA_FORMAT_STDERR,
            returncode=1,
            operation="encode-1080p-nvenc",
        )
        assert is_fallback_eligible(error) is True
