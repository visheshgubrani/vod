"""
The encoding seam: choosing *what* encodes a rendition, and proving the choice.

Three backends, one shape. What differs between them is not just the codec name
but where the frames live while they are filtered: ``libx264`` filters in system
memory, ``h264_nvenc`` can decode and scale on the GPU, ``h264_vaapi`` needs an
explicit ``hwupload``. Getting that wrong produces either an error or — worse —
a silently wrong picture, so the argument builders here are pure functions over
a :class:`RenderSpec` and are unit-tested against literals.

A word on what probing means. ``ffmpeg -hwaccels`` lists what the binary was
*compiled* with; it says nothing about whether the device node exists, whether
the driver can be opened, or whether this container was given the render group.
Every "available" answer in :mod:`openvod_transcoder.encoding.probe` therefore
comes from an actual encode of a synthetic frame. A listed-but-unusable
accelerator is the normal case on real machines, not an edge case.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol

from openvod_transcoder.config import EncodingProfile


class SourceTraits(Protocol):
    """
    The source properties an encoder actually needs.

    Deliberately a protocol rather than an import of ``VideoMetadata``: the
    encoding seam must not depend on the video package, or importing it pulls in
    the whole pipeline (and the cycle closes through ``video.transcode``). It also
    keeps the argument builders trivially testable with a two-field stub.
    """
    is_hdr: bool


# Backend names are part of the agent protocol (capabilities are reported with
# them) and of the dashboard's provider picker. They are stable identifiers.
BACKEND_CPU = "cpu"
BACKEND_NVENC = "nvenc"
BACKEND_VAAPI = "vaapi"

ALL_BACKENDS = (BACKEND_CPU, BACKEND_NVENC, BACKEND_VAAPI)


@dataclass(frozen=True)
class EncoderBackend:
    """One way of encoding H.264 on this machine."""
    name: str
    codec: str
    hardware_decode: bool
    hardware_filters: bool
    device: Optional[str] = None

    @property
    def is_hardware(self) -> bool:
        return self.name != BACKEND_CPU


CPU_BACKEND = EncoderBackend(
    name=BACKEND_CPU,
    codec="libx264",
    hardware_decode=False,
    hardware_filters=False,
)

NVENC_BACKEND = EncoderBackend(
    name=BACKEND_NVENC,
    codec="h264_nvenc",
    hardware_decode=True,
    hardware_filters=True,
    device="cuda:0",
)

VAAPI_BACKEND = EncoderBackend(
    name=BACKEND_VAAPI,
    codec="h264_vaapi",
    hardware_decode=True,
    hardware_filters=True,
    device="/dev/dri/renderD128",
)


def backend_named(name: str) -> EncoderBackend:
    """Resolve a backend name, optionally ``nvenc:1`` / ``vaapi:/dev/dri/renderD129``."""
    raw = (name or "").strip()
    if not raw:
        raise ValueError("empty encoder backend name")

    head, _, device = raw.partition(":")
    head = head.lower()
    if head in ("cpu", "software", "libx264", "auto"):
        return CPU_BACKEND
    if head in ("nvenc", "cuda", "h264_nvenc"):
        return EncoderBackend(
            name=BACKEND_NVENC,
            codec="h264_nvenc",
            hardware_decode=True,
            hardware_filters=True,
            device=device or NVENC_BACKEND.device,
        )
    if head in ("vaapi", "h264_vaapi"):
        return EncoderBackend(
            name=BACKEND_VAAPI,
            codec="h264_vaapi",
            hardware_decode=True,
            hardware_filters=True,
            device=device or VAAPI_BACKEND.device,
        )
    raise ValueError(f"unknown encoder backend: {name!r}")


@dataclass(frozen=True)
class RenderSpec:
    """
    One rendition, fully resolved: label, exact pixel dimensions, bitrates, fps.

    Dimensions are resolved *before* encoding rather than left to a
    ``scale=-2:height`` expression, for three reasons that all showed up in
    practice: the dashboard must show the dimensions that were actually encoded;
    aspect-preserving scale filters emit odd widths for some source ratios, and
    H.264 requires even ones; and Shaka needs the rendition's true resolution to
    write correct ``RESOLUTION`` attributes in the master playlist.
    """
    label: str
    width: int
    height: int
    bitrate: str
    maxrate: str
    bufsize: str
    fps: float

    @property
    def resolution(self) -> str:
        return f"{self.width}x{self.height}"

    @classmethod
    def from_profile(cls, profile: EncodingProfile, width: int, height: int, fps: float) -> "RenderSpec":
        return cls(
            label=profile.label,
            width=width,
            height=height,
            bitrate=profile.bitrate,
            maxrate=profile.maxrate,
            bufsize=profile.bufsize,
            fps=fps,
        )


def h264_level(height: int, fps: float) -> str:
    """
    H.264 level for a rendition. Pure; checked with literals.

    Levels bound macroblocks per second, so the fps term is not decoration — a
    1080p60 stream is level 4.2, and labelling it 4.1 makes some players refuse
    the stream outright.
    """
    if height >= 2160:
        return "5.2" if fps > 30 else "5.1"
    if height >= 1440:
        return "5.1" if fps > 30 else "5.0"
    if height >= 1080:
        return "4.2" if fps > 30 else "4.1"
    return "4.0"


def keyframe_interval(fps: float, segment_duration: float) -> int:
    """
    GOP length in frames, at least 1.

    Shared by the encoder and the packager: segments are only aligned when the
    encoder emits a keyframe exactly every ``segment_duration`` seconds. Rounding
    (rather than truncating) keeps the drift from accumulating over a long job.
    """
    return max(1, round(segment_duration * max(1.0, fps)))


# HDR → SDR in software. zscale + tonemap is the path FFmpeg documents and the
# one that is actually present in a stock build; `tonemap_cuda` is not guaranteed
# to exist, which is why the pipeline no longer assumes it.
TONEMAP_SDR_FILTER = (
    "zscale=t=linear:npl=100,"
    "format=gbrpf32le,"
    "zscale=p=bt709,"
    "tonemap=tonemap=hable:desat=0,"
    "zscale=t=bt709:m=bt709:r=tv,"
    "format=yuv420p"
)

# HDR transfer characteristics we know how to convert. Anything else is rejected
# rather than guessed at: shipping a washed-out or crushed picture silently is a
# worse outcome than a typed failure the owner can act on.
SUPPORTED_HDR_TRANSFERS = ("smpte2084", "arib-std-b67")


def software_filters(spec: RenderSpec, metadata: SourceTraits) -> str:
    """
    Filter chain for a CPU encode (decode, tonemap, scale, pixel format).

    The explicit ``format=yuv420p`` is not decoration. We encode with
    ``-profile:v high``, and H.264 High profile is 4:2:0 *only* — a source with
    4:4:4 or 4:2:2 chroma (ProRes mezzanines, FFV1 intermediates, some screen
    recorders) otherwise fails with "high profile doesn't support 4:4:4". That
    failure is invisible to a unit test of the argument list; it only appears
    against real media, which is why the real-media suite exists.
    """
    chain = []
    if metadata.is_hdr:
        chain.append(TONEMAP_SDR_FILTER)
    chain.append(f"scale={spec.width}:{spec.height}:flags=bicubic")
    # Preserve square pixels: anamorphic sources otherwise produce renditions
    # whose display aspect ratio disagrees with their coded one, and every
    # player disagrees about which to trust.
    chain.append("setsar=1")
    chain.append("format=yuv420p")
    return ",".join(chain)


def nvenc_filters(spec: RenderSpec, metadata: SourceTraits, *, gpu_decode: bool) -> str:
    """
    Filter chain for NVENC.

    With GPU decode the frames are already CUDA surfaces, so only ``scale_cuda``
    is valid. Without it they are in system memory and must be uploaded first.
    HDR is deliberately *not* tonemapped here: NVENC's tonemap filter is not
    present in every build, so HDR sources are routed to the software path
    instead, which is a correctness decision rather than a performance one.
    """
    if gpu_decode:
        return f"scale_cuda={spec.width}:{spec.height}:format=yuv420p"
    return f"hwupload,scale_cuda={spec.width}:{spec.height}:format=yuv420p"


def vaapi_filters(spec: RenderSpec, metadata: SourceTraits, *, gpu_decode: bool) -> str:
    """Filter chain for VAAPI: frames must be uploaded to the DRM surface first."""
    chain = []
    if gpu_decode:
        # Frames are DRM surfaces but still need scaling on the same device.
        chain.append(f"scale_vaapi=w={spec.width}:h={spec.height}:format=nv12")
    else:
        chain.append("format=nv12")
        chain.append("hwupload")
        chain.append(f"scale_vaapi=w={spec.width}:h={spec.height}:format=nv12")
    return ",".join(chain)


def video_filter_chain(
    backend: EncoderBackend,
    spec: RenderSpec,
    metadata: SourceTraits,
    *,
    gpu_decode: bool,
) -> str:
    """
    The filter chain for a backend/source combination.

    Hardware decoding and filtering are only used when the caller has already
    verified that *this* source decodes on that device (see the preflight in
    :mod:`openvod_transcoder.encoding.probe`); passing ``gpu_decode`` is that
    verification's result, not an assumption.
    """
    if metadata.is_hdr and backend.is_hardware:
        # Route HDR through the software chain even when the backend is a GPU:
        # the CUDA tonemap filter is not guaranteed to exist, and a hard failure
        # mid-job is worse than a slower correct one.
        return software_filters(spec, metadata)
    if backend.name == BACKEND_NVENC:
        return nvenc_filters(spec, metadata, gpu_decode=gpu_decode)
    if backend.name == BACKEND_VAAPI:
        return vaapi_filters(spec, metadata, gpu_decode=gpu_decode)
    return software_filters(spec, metadata)


def input_args(backend: EncoderBackend, metadata: SourceTraits, *, gpu_decode: bool) -> list[str]:
    """Decoder-side arguments, including the hardware device when one is used."""
    if not backend.is_hardware or not gpu_decode:
        return []
    if backend.name == BACKEND_NVENC:
        return [
            "-threads", "1",
            "-hwaccel", "cuda",
            "-hwaccel_output_format", "cuda",
            "-extra_hw_frames", "8",
        ]
    return [
        "-hwaccel", "vaapi",
        "-hwaccel_device", backend.device or VAAPI_BACKEND.device,
        "-hwaccel_output_format", "vaapi",
    ]


def video_encode_args(backend: EncoderBackend, spec: RenderSpec) -> list[str]:
    """Encoder-side arguments for one rendition."""
    if backend.name == BACKEND_NVENC:
        return [
            "-c:v", backend.codec,
            "-preset:v", "p4",
            "-tune:v", "hq",
            "-rc:v", "vbr",
            "-profile:v", "high",
            "-level:v", h264_level(spec.height, spec.fps),
            "-b:v", spec.bitrate,
            "-maxrate:v", spec.maxrate,
            "-bufsize:v", spec.bufsize,
            "-bf", "2",
        ]
    if backend.name == BACKEND_VAAPI:
        return [
            "-c:v", backend.codec,
            "-profile:v", "high",
            "-level:v", h264_level(spec.height, spec.fps),
            # VAAPI's rate control is configured as a bitrate on the encoder
            # rather than through -maxrate/-bufsize, which it rejects.
            "-b:v", spec.bitrate,
            "-maxrate", spec.maxrate,
            "-bufsize", spec.bufsize,
            "-bf", "2",
        ]
    return [
        "-c:v", backend.codec,
        # `veryfast` is the deliberate choice for a machine the owner also uses:
        # on CPU, x264's slow presets trade minutes of wall clock for a few
        # percent of bitrate, which is the wrong trade on a laptop.
        "-preset", "veryfast",
        "-profile:v", "high",
        "-level:v", h264_level(spec.height, spec.fps),
        "-b:v", spec.bitrate,
        "-maxrate:v", spec.maxrate,
        "-bufsize:v", spec.bufsize,
        "-bf", "2",
        "-sc_threshold", "0",
    ]


def video_common_args(spec: RenderSpec, segment_duration: float) -> list[str]:
    """Frame-rate, GOP and container arguments shared by every backend."""
    gop = keyframe_interval(spec.fps, segment_duration)
    return [
        "-r", f"{spec.fps:g}",
        "-g", str(gop),
        "-keyint_min", str(gop),
        "-no-scenecut", "1",
        "-an",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    ]


def build_video_command(
    *,
    ffmpeg: str,
    input_path: str,
    output_path: str,
    backend: EncoderBackend,
    spec: RenderSpec,
    metadata: SourceTraits,
    segment_duration: float,
    gpu_decode: bool,
) -> list[str]:
    """Full FFmpeg command for one video rendition."""
    return [
        ffmpeg, "-hide_banner", "-y",
        *input_args(backend, metadata, gpu_decode=gpu_decode),
        "-i", input_path,
        "-vf", video_filter_chain(backend, spec, metadata, gpu_decode=gpu_decode),
        *video_encode_args(backend, spec),
        *video_common_args(spec, segment_duration),
        output_path,
    ]


def build_audio_command(
    *,
    ffmpeg: str,
    input_path: str,
    output_path: str,
    audio_stream: int | None = None,
    bitrate: str = "128k",
) -> list[str]:
    """
    Normalize the default audio track to stereo AAC.

    ``loudnorm`` is applied because the ladder normalizes video but not audio,
    and a lecture recorded at -30 LUFS next to one at -12 LUFS is unusable in a
    course. ``audio_stream`` pins the selected track's index; ``None`` lets
    FFmpeg take its default, which is the documented behaviour.
    """
    return [
        ffmpeg, "-hide_banner", "-y",
        "-i", input_path,
        *([] if audio_stream is None else ["-map", f"0:{audio_stream}"]),
        "-vn",
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:a", "aac",
        "-b:a", bitrate,
        "-ac", "2",
        "-ar", "48000",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        output_path,
    ]


def even(value: int) -> int:
    """
    Nearest even integer, at least 2.

    H.264 codes in 2x2 chroma blocks, so an odd width or height is either
    rejected by the encoder or silently padded by the scaler. Rounding here keeps
    the encoder and the packager's RESOLUTION metadata in agreement.
    """
    rounded = int(round(value))
    if rounded % 2:
        rounded -= 1
    return max(2, rounded)


def fit_dimensions(source_width: int, source_height: int, target_height: int) -> tuple[int, int]:
    """
    Scale a source to ``target_height`` preserving aspect ratio, never upscaling.

    Returns even dimensions. A source at or below the target keeps its own size
    (rounded to even), which is what "never upscale" means in practice. A source
    with unusable dimensions returns ``(0, 0)`` — audio-only has nothing to scale.
    """
    if source_width <= 0 or source_height <= 0:
        return (0, 0)
    if target_height >= source_height:
        return (even(source_width), even(source_height))
    scale = target_height / float(source_height)
    width = even(source_width * scale)
    height = even(target_height)
    # Guard against rounding making the rendition taller than the source.
    if height > source_height:
        height = even(source_height)
    return (width, height)
