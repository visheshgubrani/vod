"""Encoding seam: FFmpeg argument construction, probe classification, fallback."""
import subprocess

import pytest

from openvod_transcoder.config import EncodingProfile
from openvod_transcoder.encoding.backends import (
    BACKEND_CPU,
    BACKEND_NVENC,
    BACKEND_VAAPI,
    CPU_BACKEND,
    NVENC_BACKEND,
    VAAPI_BACKEND,
    RenderSpec,
    backend_named,
    build_audio_command,
    build_video_command,
    h264_level,
    keyframe_interval,
    software_filters,
    video_filter_chain,
)
from openvod_transcoder.encoding.probe import (
    CapabilityReport,
    EncoderProbe,
    classify_probe_failure,
    detect_capabilities,
    parse_encoder_list,
    parse_hwaccels,
    preflight_source,
    probe_backend,
)
from openvod_transcoder.encoding.selection import (
    BackendCandidate,
    FallbackState,
    describe_chain,
    select_chain,
)
from openvod_transcoder.errors import (
    ERROR_ENCODER_UNAVAILABLE,
    ERROR_EMPTY_FILE,
    ERROR_PACKAGING_FAILED,
    TranscodeError,
)
from openvod_transcoder.video.analysis import VideoMetadata


class Traits:
    """Stands in for VideoMetadata: the encoder only asks about HDR."""
    def __init__(self, is_hdr=False):
        self.is_hdr = is_hdr


SDR = Traits(is_hdr=False)
HDR = Traits(is_hdr=True)

SPEC_1080 = RenderSpec(
    label="1080p", width=1920, height=1080,
    bitrate="5M", maxrate="6M", bufsize="10M", fps=30.0,
)


class TestH264Level:
    def test_1080p30_is_level_4_1(self):
        assert h264_level(1080, 30.0) == "4.1"

    def test_1080p60_is_level_4_2(self):
        # A 1080p60 stream labelled 4.1 is refused outright by some players.
        assert h264_level(1080, 60.0) == "4.2"

    def test_2160p_high_frame_rate(self):
        assert h264_level(2160, 60.0) == "5.2"
        assert h264_level(2160, 24.0) == "5.1"

    def test_low_resolutions_share_level_4_0(self):
        assert h264_level(720, 30.0) == "4.0"
        assert h264_level(360, 24.0) == "4.0"


class TestKeyframeInterval:
    def test_four_second_segments_at_30fps(self):
        assert keyframe_interval(30.0, 4.0) == 120

    def test_rounds_rather_than_truncates(self):
        # 23.976 * 4 = 95.904 -> 96, so drift does not accumulate over hours.
        assert keyframe_interval(23.976, 4.0) == 96

    def test_never_zero(self):
        assert keyframe_interval(0.0, 4.0) == 4
        assert keyframe_interval(30.0, 0.0) == 1


class TestBackendNamed:
    def test_plain_names(self):
        assert backend_named("cpu").codec == "libx264"
        assert backend_named("nvenc").codec == "h264_nvenc"
        assert backend_named("vaapi").codec == "h264_vaapi"

    def test_explicit_device_is_carried(self):
        assert backend_named("nvenc:1").device == "1"
        assert backend_named("vaapi:/dev/dri/renderD129").device == "/dev/dri/renderD129"

    def test_unknown_backend_is_rejected_not_defaulted(self):
        with pytest.raises(ValueError, match="unknown encoder backend"):
            backend_named("quicksync")


class TestFilterChains:
    def test_software_chain_tonemaps_hdr_then_scales(self):
        chain = software_filters(SPEC_1080, HDR)
        assert chain.startswith("zscale=t=linear:npl=100")
        assert "tonemap=tonemap=hable" in chain
        assert "scale=1920:1080:flags=bicubic,setsar=1" in chain

    def test_software_chain_skips_tonemapping_for_sdr(self):
        assert software_filters(SPEC_1080, SDR).startswith(
            "scale=1920:1080:flags=bicubic,setsar=1"
        )

    def test_software_chain_forces_420_chroma(self):
        # `-profile:v high` is 4:2:0 only. Without this conversion a 4:4:4 source
        # fails with "high profile doesn't support 4:4:4" — a real failure that
        # only shows up against real media.
        assert software_filters(SPEC_1080, SDR).endswith("format=yuv420p")
        assert software_filters(SPEC_1080, HDR).endswith("format=yuv420p")

    def test_nvenc_uses_cuda_scaling_only_with_gpu_decode(self):
        assert (
            video_filter_chain(NVENC_BACKEND, SPEC_1080, SDR, gpu_decode=True)
            == "scale_cuda=1920:1080:format=yuv420p"
        )
        assert video_filter_chain(NVENC_BACKEND, SPEC_1080, SDR, gpu_decode=False).startswith(
            "hwupload,scale_cuda="
        )

    def test_vaapi_uploads_before_scaling(self):
        assert video_filter_chain(VAAPI_BACKEND, SPEC_1080, SDR, gpu_decode=False) == (
            "format=nv12,hwupload,scale_vaapi=w=1920:h=1080:format=nv12"
        )

    def test_hdr_on_hardware_routes_through_the_software_tonemap(self):
        # `tonemap_cuda` is not present in every build; a hard mid-job failure is
        # worse than a slower correct path.
        chain = video_filter_chain(NVENC_BACKEND, SPEC_1080, HDR, gpu_decode=True)
        assert "tonemap=tonemap=hable" in chain
        assert "scale_cuda" not in chain


class TestBuildVideoCommand:
    def _cmd(self, backend, gpu_decode):
        return build_video_command(
            ffmpeg="ffmpeg",
            input_path="/w/in.mp4",
            output_path="/w/video_1080p.mp4",
            backend=backend,
            spec=SPEC_1080,
            metadata=SDR,
            segment_duration=4.0,
            gpu_decode=gpu_decode,
        )

    def test_cpu_command_uses_libx264_and_no_hwaccel(self):
        cmd = self._cmd(CPU_BACKEND, gpu_decode=False)
        assert "-hwaccel" not in cmd
        assert cmd[cmd.index("-c:v") + 1] == "libx264"
        assert cmd[cmd.index("-g") + 1] == "120"
        assert cmd[-1] == "/w/video_1080p.mp4"
        assert "-an" in cmd

    def test_nvenc_gpu_decode_adds_cuda_hwaccel(self):
        cmd = self._cmd(NVENC_BACKEND, gpu_decode=True)
        assert cmd[cmd.index("-hwaccel") + 1] == "cuda"
        assert cmd[cmd.index("-c:v") + 1] == "h264_nvenc"

    def test_vaapi_pins_the_device(self):
        cmd = build_video_command(
            ffmpeg="ffmpeg",
            input_path="/w/in.mp4",
            output_path="/w/out.mp4",
            backend=backend_named("vaapi:/dev/dri/renderD129"),
            spec=SPEC_1080,
            metadata=SDR,
            segment_duration=4.0,
            gpu_decode=True,
        )
        assert cmd[cmd.index("-hwaccel_device") + 1] == "/dev/dri/renderD129"

    def test_fragmented_mp4_flags_present(self):
        cmd = self._cmd(CPU_BACKEND, gpu_decode=False)
        assert cmd[cmd.index("-movflags") + 1] == "+frag_keyframe+empty_moov+default_base_moof"


class TestBuildAudioCommand:
    def test_normalizes_to_stereo_aac_48k(self):
        cmd = build_audio_command(
            ffmpeg="ffmpeg", input_path="/w/in.mp4", output_path="/w/audio.mp4"
        )
        assert cmd[cmd.index("-c:a") + 1] == "aac"
        assert cmd[cmd.index("-ac") + 1] == "2"
        assert cmd[cmd.index("-ar") + 1] == "48000"
        assert "loudnorm=I=-16:TP=-1.5:LRA=11" in cmd
        assert "-vn" in cmd

    def test_selected_track_is_pinned(self):
        cmd = build_audio_command(
            ffmpeg="ffmpeg", input_path="/w/in.mp4", output_path="/w/audio.mp4", audio_stream=3
        )
        assert cmd[cmd.index("-map") + 1] == "0:3"

    def test_no_map_when_no_track_was_selected(self):
        cmd = build_audio_command(
            ffmpeg="ffmpeg", input_path="/w/in.mp4", output_path="/w/audio.mp4"
        )
        assert "-map" not in cmd


class TestClassifyProbeFailure:
    def test_missing_device_is_device_unavailable(self):
        assert classify_probe_failure(
            "[AVHWDeviceContext @ 0x1] Cannot open device /dev/dri/renderD128"
        ) == "device-unavailable"

    def test_permission_denied_is_device_unavailable(self):
        assert classify_probe_failure(
            "Failed to initialise VAAPI connection: -1 (unknown libva error)."
        ) == "device-unavailable"

    def test_out_of_memory_is_session_exhausted_and_therefore_transient(self):
        # Retrying the same backend after a wait is the right answer, not
        # re-encoding the whole job on the CPU.
        assert classify_probe_failure(
            "OpenEncodeSessionEx failed: out of memory (10)"
        ) == "session-exhausted"

    def test_pixel_format_problems_are_their_own_verdict(self):
        assert classify_probe_failure(
            "Impossible to convert between the formats supported by the filter"
        ) == "unsupported-format"

    def test_anything_else_is_an_encode_failure(self):
        assert classify_probe_failure("Invalid data found when processing input") == "encode-failed"


class TestInventoryParsing:
    FFMPEG_ENCODERS = """
Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
"""

    def test_encoder_names_are_extracted(self):
        assert parse_encoder_list(self.FFMPEG_ENCODERS) == [
            "h264_nvenc", "h264_vaapi", "libx264", "libx265",
        ]

    def test_hwaccels_header_is_skipped(self):
        assert parse_hwaccels(
            "Hardware acceleration methods:\ncuda\nvaapi\n"
        ) == ["cuda", "vaapi"]

    def test_empty_output_yields_nothing(self):
        assert parse_hwaccels("") == []
        assert parse_encoder_list("") == []


class TestProbeBackend:
    def _run(self, returncode, stderr=""):
        def runner(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, returncode, "", stderr)
        return runner

    def test_successful_encode_marks_the_backend_available(self):
        probe = probe_backend(CPU_BACKEND, run=self._run(0))
        assert probe.available is True

    def test_failed_encode_records_the_kind(self):
        probe = probe_backend(
            VAAPI_BACKEND,
            run=self._run(1, "Cannot open device /dev/dri/renderD128"),
        )
        assert probe.available is False
        assert probe.failure_kind == "device-unavailable"

    def test_missing_binary_is_reported_not_raised(self):
        def runner(cmd, **kwargs):
            raise FileNotFoundError("ffmpeg")

        probe = probe_backend(CPU_BACKEND, run=runner)
        assert probe.available is False
        assert "not found" in probe.reason

    def test_vaapi_command_initialises_the_named_device(self):
        from openvod_transcoder.encoding.probe import synthetic_command

        cmd = synthetic_command("ffmpeg", VAAPI_BACKEND)
        assert cmd[cmd.index("-init_hw_device") + 1] == "vaapi=va:/dev/dri/renderD128"


class TestPreflightSource:
    def test_full_hardware_path_success_is_reported_as_such(self):
        def runner(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 0, "", "")

        probe = preflight_source(
            __import__("pathlib").Path("/media/in.mp4"),
            VideoMetadata(
                width=3840, height=2160, duration=60.0, fps=30.0, has_audio=True,
                has_video=True, is_hdr=False, codec_name="hevc",
            ),
            NVENC_BACKEND,
            run=runner,
        )
        assert probe.hardware_decode is True
        assert probe.hardware_filters is True

    def test_hardware_decode_rejection_falls_back_to_hybrid_and_says_so(self):
        calls = []

        def runner(cmd, **kwargs):
            calls.append(cmd)
            # First attempt (hardware decode) fails; the hybrid attempt succeeds.
            return subprocess.CompletedProcess(
                cmd, 0 if len(calls) > 1 else 1,
                "", "" if len(calls) > 1 else "Impossible to convert between the formats",
            )

        probe = preflight_source(
            __import__("pathlib").Path("/media/in.mp4"),
            VideoMetadata(
                width=3840, height=2160, duration=60.0, fps=30.0, has_audio=True,
                has_video=True, is_hdr=False, codec_name="hevc",
            ),
            NVENC_BACKEND,
            run=runner,
        )
        assert probe.hardware_decode is False
        assert "software decode" in probe.reason

    def test_both_paths_failing_reports_the_last_reason(self):
        def runner(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 1, "", "Unknown encoder 'h264_nvenc'")

        probe = preflight_source(
            __import__("pathlib").Path("/media/in.mp4"),
            VideoMetadata(
                width=1920, height=1080, duration=60.0, fps=30.0, has_audio=True,
                has_video=True, is_hdr=False, codec_name="h264",
            ),
            NVENC_BACKEND,
            run=runner,
        )
        assert probe.hardware_decode is False
        assert "failed" in probe.reason


def report_with(**availability):
    return CapabilityReport(
        encoders={
            name: EncoderProbe(backend=name, available=availability.get(name, False))
            for name in ("cpu", "nvenc", "vaapi")
        }
    )


class TestSelectChain:
    def test_auto_prefers_nvenc_then_vaapi_then_cpu(self):
        chain = select_chain("auto", report_with(cpu=True, nvenc=True, vaapi=True))
        assert [candidate.label for candidate in chain] == [
            "nvenc", "nvenc+software-decode", "vaapi", "vaapi+software-decode", "cpu",
        ]

    def test_auto_skips_unavailable_hardware(self):
        chain = select_chain("auto", report_with(cpu=True, nvenc=False, vaapi=True))
        assert [candidate.backend.name for candidate in chain] == ["vaapi", "vaapi", "cpu"]

    def test_auto_with_no_verified_backend_still_attempts_cpu(self):
        # The probe itself can fail for environmental reasons; a real attempt
        # produces a far better error message than "nothing is available".
        chain = select_chain("auto", report_with())
        assert [candidate.backend.name for candidate in chain] == ["cpu"]

    def test_explicit_cpu_is_only_cpu(self):
        assert describe_chain(select_chain("cpu", report_with(cpu=True, nvenc=True))) == "cpu"

    def test_explicit_unavailable_gpu_fails_with_an_actionable_message(self):
        with pytest.raises(TranscodeError) as caught:
            select_chain("nvenc", report_with(cpu=True, nvenc=False))
        assert caught.value.code == ERROR_ENCODER_UNAVAILABLE
        assert "NVIDIA Container Toolkit" in caught.value.message
        assert "Select 'cpu'" in caught.value.message

    def test_explicit_vaapi_never_silently_becomes_cpu(self):
        with pytest.raises(TranscodeError) as caught:
            select_chain("vaapi", report_with(cpu=True, vaapi=False))
        assert "render" in caught.value.message

    def test_explicit_gpu_device_override(self):
        chain = select_chain("nvenc", report_with(cpu=True, nvenc=True), device="1")
        assert chain[0].backend.device == "1"


class TestFallbackState:
    def _state(self):
        chain = select_chain("auto", report_with(cpu=True, nvenc=True))
        return FallbackState(chain=chain)

    def test_advances_on_an_encoder_failure(self):
        state = self._state()
        assert state.current.label == "nvenc"
        assert state.advance(TranscodeError("ENCODER_FAILED", "gpu died")).label == (
            "nvenc+software-decode"
        )

    def test_advances_from_hybrid_to_cpu(self):
        state = self._state()
        state.advance(TranscodeError("ENCODER_FAILED", "x"))
        assert state.advance(TranscodeError("ENCODER_FAILED", "y")).label == "cpu"

    def test_exhausted_chain_stops_retrying(self):
        state = self._state()
        state.advance(TranscodeError("ENCODER_FAILED", "x"))
        state.advance(TranscodeError("ENCODER_FAILED", "y"))
        assert state.advance(TranscodeError("ENCODER_FAILED", "z")) is None

    def test_bad_media_never_triggers_a_fallback(self):
        state = self._state()
        assert state.advance(TranscodeError(ERROR_EMPTY_FILE, "0 bytes")) is None
        assert state.current.label == "nvenc"

    def test_missing_file_never_triggers_a_fallback(self):
        state = self._state()
        assert state.advance(FileNotFoundError("gone")) is None

    def test_packaging_failures_are_fallback_eligible(self):
        state = self._state()
        assert state.advance(TranscodeError(ERROR_PACKAGING_FAILED, "shaka died")) is not None

    def test_reasons_are_recorded_for_support(self):
        state = self._state()
        state.advance(TranscodeError("ENCODER_FAILED", "no free encoding session"))
        assert "no free encoding session" in state.fallback_reasons[0]


class TestDetectCapabilities:
    def test_not_compiled_codec_is_reported_without_probing(self):
        def runner(cmd, **kwargs):
            if "-encoders" in cmd:
                return subprocess.CompletedProcess(cmd, 0, " V....D libx264  (codec h264)", "")
            if "-hwaccels" in cmd:
                return subprocess.CompletedProcess(cmd, 0, "Hardware acceleration methods:\n", "")
            return subprocess.CompletedProcess(cmd, 0, "ffmpeg version 6.1", "")

        report = detect_capabilities(run=runner)
        assert report.encoders["cpu"].available is True
        assert report.encoders["nvenc"].failure_kind == "not-compiled"
        assert report.ffmpeg.startswith("ffmpeg version 6.1")

    def test_payload_never_contains_host_paths(self):
        report = detect_capabilities(probe=False)
        payload = report.to_payload()
        assert set(payload) == {
            "ffmpeg", "shaka", "hwaccels", "encoders", "cpuCores",
            "memoryBytes", "scratchFreeBytes", "probedAt",
        }
        assert "device" not in payload["encoders"]["nvenc"]


class TestBackendIdentity:
    def test_only_cpu_is_not_hardware(self):
        assert CPU_BACKEND.is_hardware is False
        assert NVENC_BACKEND.is_hardware is True
        assert VAAPI_BACKEND.is_hardware is True

    def test_backend_constants_are_the_wire_identifiers(self):
        assert (BACKEND_CPU, BACKEND_NVENC, BACKEND_VAAPI) == ("cpu", "nvenc", "vaapi")
        assert BackendCandidate(CPU_BACKEND, gpu_decode=False).label == "cpu"
