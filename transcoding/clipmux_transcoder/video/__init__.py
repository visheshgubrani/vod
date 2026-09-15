"""Video processing modules for analysis, transcoding, poster generation, and transcription."""
from clipmux_transcoder.video.analysis import (
    VideoMetadata,
    get_video_metadata,
    parse_ffprobe,
    select_optimal_ladder,
)
from clipmux_transcoder.video.poster import generate_poster
from clipmux_transcoder.video.transcode import transcode_rendition, transcode_audio
from clipmux_transcoder.video.transcription import transcribe_to_vtt
from clipmux_transcoder.video.chapters import generate_chapters

__all__ = [
    "VideoMetadata",
    "get_video_metadata",
    "parse_ffprobe",
    "select_optimal_ladder",
    "generate_poster",
    "transcode_rendition",
    "transcode_audio",
    "transcribe_to_vtt",
    "generate_chapters",
]
