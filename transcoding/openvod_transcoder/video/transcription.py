"""
AI Transcription Module - Using faster-whisper

Generates VTT subtitles from audio using the faster-whisper library with the
large-v3-turbo model for optimal speed/quality balance.

Two rules this module did not always follow, and both are load-bearing:

**CUDA first, CPU as a retry.** GPU inference is much faster, but a host whose
driver, cuDNN or CTranslate2 build disagrees with the image will fail *after* the
model has loaded — sometimes after the first segments have already been produced.
Retrying the whole transcription on the CPU with INT8 is the difference between a
video with subtitles and a video with none.

**Publish only a complete VTT.** `transcribe()` returns a lazy generator, so the
old code wrote cues to the destination as they arrived: a failure half way
through left a truncated subtitle file that the artifact inventory then published
as a finished one. The cues are collected first, and the file is written to a
temporary path and atomically renamed — a reader never sees a partial document.
"""
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple

# CUDA first (fast), then CPU. INT8 is the CPU compute type faster-whisper
# documents for exactly this fallback.
GPU_ATTEMPT = ("cuda", "float16")
CPU_ATTEMPT = ("cpu", "int8")

# Failures that mean "this GPU cannot do the work right now", as opposed to "the
# request is wrong". Matched case-insensitively against the exception text.
#
# The distinction is the same one the encoder fallback makes: an unsupported
# language is not fixed by a different device, and retrying it wastes minutes.
GPU_FAILURE_PATTERNS: Sequence[str] = (
    "cuda",
    "cudnn",
    "cublas",
    "libcuda",
    "no kernel image",
    "ctranslate2",
    "gpu",
    "nvml",
    "driver version",
    "out of memory",
    "device-side assert",
)


def is_gpu_runtime_failure(exc: BaseException) -> bool:
    """True when a different *device* could plausibly succeed."""
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(pattern in text for pattern in GPU_FAILURE_PATTERNS)


def extract_audio(input_path: str | Path, output_path: str | Path) -> Path:
    """Extract audio from video for transcription."""
    output_path = Path(output_path)
    
    cmd = [
        "ffmpeg", "-y",
        "-i", str(input_path),
        "-vn",                      # No video
        "-acodec", "pcm_s16le",     # WAV format for whisper
        "-ar", "16000",             # 16kHz sample rate (whisper optimal)
        "-ac", "1",                 # Mono
        str(output_path)
    ]
    
    subprocess.run(cmd, check=True, capture_output=True)
    return output_path


def format_timestamp(seconds: float) -> str:
    """Format seconds to VTT timestamp (HH:MM:SS.mmm)."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def iter_subtitle_cues(
    segment,
    max_chars: int = 84,
    max_duration: float = 4.0,
    max_gap: float = 0.8,
):
    """
    Convert a Whisper segment into smaller subtitle cues.

    Whisper segments are often paragraph-sized; this splits by word timestamps
    and caps cue duration/length for readable VTT output.
    """
    words = getattr(segment, "words", None)
    if not words:
        text = segment.text.strip()
        if text:
            yield segment.start, segment.end, text
        return

    cue_tokens = []
    cue_start = None
    cue_end = None
    prev_end = None

    def flush():
        nonlocal cue_tokens, cue_start, cue_end
        text = "".join(cue_tokens).strip()
        if text and cue_start is not None and cue_end is not None:
            return cue_start, cue_end, text
        return None

    for word in words:
        token = getattr(word, "word", "")
        start = getattr(word, "start", None)
        end = getattr(word, "end", None)
        if not token or start is None or end is None:
            continue

        next_text = "".join(cue_tokens + [token]).strip()
        too_long = len(next_text) > max_chars and len(cue_tokens) > 0
        too_slow = cue_start is not None and (end - cue_start) > max_duration
        big_gap = prev_end is not None and (start - prev_end) > max_gap

        if too_long or too_slow or big_gap:
            flushed = flush()
            if flushed:
                yield flushed
            cue_tokens = []
            cue_start = None
            cue_end = None

        if cue_start is None:
            cue_start = start
        cue_tokens.append(token)
        cue_end = end
        prev_end = end

    flushed = flush()
    if flushed:
        yield flushed


def transcribe_to_vtt(
    input_path: str | Path,
    output_path: str | Path,
    model_size: str = "large-v3-turbo",
    language: Optional[str] = None,
    *,
    attempts: Optional[Sequence[Tuple[str, str]]] = None,
) -> Path:
    """
    Transcribe video/audio to VTT subtitles using faster-whisper.

    The GPU is tried first and a recognised GPU failure is retried once on the
    CPU with INT8, using the same model and language settings — only the device
    and compute type change, so the retry produces the subtitles the caller asked
    for rather than a different transcription.

    Args:
        input_path: Path to the video/audio file
        output_path: Path for the output VTT file
        model_size: Whisper model size (default: large-v3-turbo)
        language: Force language (None for auto-detect)

    Returns:
        Path to the generated VTT file

    Raises:
        The last attempt's exception. A partial VTT is never published.
    """
    input_path = Path(input_path)
    output_path = Path(output_path)
    work_dir = output_path.parent
    plan = tuple(attempts) if attempts is not None else (GPU_ATTEMPT, CPU_ATTEMPT)
    if not plan:
        # `attempts=None` means "use the default"; an explicit empty sequence is
        # a caller bug. Without the guard it would skip the loop and publish a
        # header-only VTT that downstream cannot tell from "no speech".
        raise ValueError("transcription needs at least one (device, compute_type) attempt")

    print(f"🎤 Starting transcription with {model_size}...")

    # Extract audio to WAV for optimal whisper performance
    audio_path = work_dir / "transcribe_audio.wav"
    print("📢 Extracting audio...")
    extract_audio(input_path, audio_path)

    try:
        cues: List[Tuple[float, float, str]] = []
        for index, (device, compute_type) in enumerate(plan):
            try:
                cues = _collect_cues(
                    audio_path,
                    model_size=model_size,
                    language=language,
                    device=device,
                    compute_type=compute_type,
                )
                break
            except Exception as exc:  # noqa: BLE001 — the policy below decides
                is_last = index == len(plan) - 1
                # Every other path ends in a raise, so there is no "last error"
                # to carry out of the loop: the failure either stops the job here
                # or is retried on the next attempt.
                if is_last or not is_gpu_runtime_failure(exc):
                    raise
                print(
                    f"⚠️ Whisper failed on {device} ({exc}); retrying on CPU with INT8"
                )

        _write_vtt(output_path, cues)
    finally:
        # Cleanup temp audio — on success *and* on failure, so a retried job does
        # not leave a 100 MB WAV behind in the attempt directory.
        if audio_path.exists():
            audio_path.unlink()

    print(f"✅ Transcription complete: {len(cues)} cues generated")
    return output_path


def _collect_cues(
    audio_path: Path,
    *,
    model_size: str,
    language: Optional[str],
    device: str,
    compute_type: str,
) -> List[Tuple[float, float, str]]:
    """
    Run one transcription attempt and *materialize* its cues.

    The list is the point: `segments` is a lazy generator, so a failure while
    iterating it (the GPU dying mid-file is the common case) has to surface here
    — inside the attempt, where the CPU retry can still catch it — rather than
    during the write, where the only remaining option is a truncated file.
    """
    from faster_whisper import WhisperModel

    try:
        from faster_whisper import BatchedInferencePipeline
    except ImportError:
        BatchedInferencePipeline = None

    print(f"🧠 Loading Whisper model: {model_size} on {device} ({compute_type})...")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    transcribe_options = {
        "beam_size": 5,
        "word_timestamps": True,
        "vad_filter": True,  # Filter out non-speech
    }
    if language:
        transcribe_options["language"] = language

    # faster-whisper batching is supported via BatchedInferencePipeline.
    if BatchedInferencePipeline is not None:
        batched_model = BatchedInferencePipeline(model=model)
        segments, info = batched_model.transcribe(
            str(audio_path),
            batch_size=8,
            **transcribe_options,
        )
    else:
        print("⚠️ BatchedInferencePipeline unavailable; falling back to non-batched transcription")
        segments, info = model.transcribe(str(audio_path), **transcribe_options)

    detected_lang = getattr(info, "language", None)
    probability = getattr(info, "language_probability", None)
    if detected_lang:
        print(f"🌐 Detected language: {detected_lang} (probability: {probability:.2%})")

    cues: List[Tuple[float, float, str]] = []
    for segment in segments:
        cues.extend(iter_subtitle_cues(segment))
    return cues


def _write_vtt(output_path: Path, cues: Sequence[Tuple[float, float, str]]) -> None:
    """
    Write the complete VTT, atomically.

    The temporary file lives in the destination directory so the rename is on one
    filesystem, and the destination is only ever replaced by a finished document.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(
        dir=str(output_path.parent), prefix=".subtitles-", suffix=".vtt.tmp"
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as target:
            target.write("WEBVTT\n\n")
            for index, (cue_start, cue_end, text) in enumerate(cues, start=1):
                target.write(f"{index}\n")
                target.write(f"{format_timestamp(cue_start)} --> {format_timestamp(cue_end)}\n")
                target.write(f"{text}\n\n")
        os.replace(temporary, output_path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
