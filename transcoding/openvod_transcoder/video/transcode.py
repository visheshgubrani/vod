"""
Rendition transcoding, expressed in terms of the encoding seam.

This module used to be where the FFmpeg command line lived, which is exactly why
the pipeline could only ever run on one machine: the command embedded an L4's
capabilities (NVDEC, ``tonemap_cuda``, three concurrent 4K decodes) as literals.

Command construction now lives in :mod:`openvod_transcoder.encoding.backends` as
pure functions over a :class:`~openvod_transcoder.encoding.backends.RenderSpec`,
and this module is the thin execution layer: run the command, report progress,
honour cancellation, validate the output.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.encoding.backends import (
    BACKEND_CPU,
    EncoderBackend,
    RenderSpec,
    backend_named,
    build_audio_command,
    build_video_command,
    fit_dimensions,
)
from openvod_transcoder.errors import ERROR_ENCODER_FAILED, TranscodeError
from openvod_transcoder.ffmpeg_progress import StallPolicy, run_ffmpeg
from openvod_transcoder.video.analysis import VideoMetadata


def transcode_rendition(
    input_path: Path,
    output_path: Path,
    profile,
    metadata: VideoMetadata,
    *,
    backend: Optional[EncoderBackend] = None,
    segment_duration: float = 4.0,
    gpu_decode: bool = True,
    token: Optional[CancellationToken] = None,
    on_progress=None,
    stall_timeout_seconds: float = 900.0,
    ffmpeg: str = "ffmpeg",
) -> Path:
    """
    Encode one rendition of ``input_path``.

    ``profile`` is an :class:`~openvod_transcoder.config.EncodingProfile` (or any
    object with ``label``/``height``/``bitrate``/``maxrate``/``bufsize``); the
    pixel dimensions are resolved here so callers do not have to reason about the
    source's aspect ratio or about even-dimension rounding.
    """
    chosen = backend or backend_named(BACKEND_CPU)
    width, height = fit_dimensions(metadata.width, metadata.height, profile.height)
    spec = RenderSpec.from_profile(profile, width, height, fps=metadata.fps or 30.0)

    cmd = build_video_command(
        ffmpeg=ffmpeg,
        input_path=str(input_path),
        output_path=str(output_path),
        backend=chosen,
        spec=spec,
        metadata=metadata,
        segment_duration=segment_duration,
        gpu_decode=gpu_decode and chosen.is_hardware,
    )

    run_ffmpeg(
        cmd,
        label=f"encode-{profile.label}",
        duration=metadata.duration,
        on_progress=on_progress,
        cancellation=token,
        stall=StallPolicy(timeout_seconds=stall_timeout_seconds),
    )

    if not output_path.exists():
        raise TranscodeError(
            ERROR_ENCODER_FAILED, f"{chosen.name} produced no output for {profile.label}"
        )
    size = output_path.stat().st_size
    if size < 1000:
        raise TranscodeError(
            ERROR_ENCODER_FAILED,
            f"{chosen.name} output for {profile.label} is {size} bytes — encoding failed",
        )

    print(f"✅ {profile.label}: {size / 1024 / 1024:.1f} MB ({spec.resolution})")
    return output_path


def transcode_audio(
    input_path: Path,
    output_path: Path,
    *,
    audio_stream: Optional[int] = None,
    token: Optional[CancellationToken] = None,
    ffmpeg: str = "ffmpeg",
) -> Path:
    """
    Normalize the selected audio track to stereo AAC in a fragmented MP4.

    The default track is chosen by :func:`openvod_transcoder.planning.plan_audio`
    and its index pinned here, so a file whose first stream is a commentary or an
    alternate language does not silently become the delivered audio.
    """
    run_ffmpeg(
        build_audio_command(
            ffmpeg=ffmpeg,
            input_path=str(input_path),
            output_path=str(output_path),
            audio_stream=audio_stream,
        ),
        label="encode-audio",
        on_progress=None,
        cancellation=token,
        stall=StallPolicy(timeout_seconds=900.0),
    )

    if not output_path.exists() or output_path.stat().st_size < 1000:
        raise TranscodeError(ERROR_ENCODER_FAILED, f"audio output invalid: {output_path}")

    print(f"✅ Audio: {output_path.stat().st_size / 1024 / 1024:.1f} MB")
    return output_path
