"""
AI Transcription Module - Using faster-whisper

Generates VTT subtitles from audio using the faster-whisper library
with the large-v3-turbo model for optimal speed/quality balance.
"""
import os
import subprocess
from pathlib import Path
from typing import Optional


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
) -> Path:
    """
    Transcribe video/audio to VTT subtitles using faster-whisper.
    
    Args:
        input_path: Path to the video/audio file
        output_path: Path for the output VTT file
        model_size: Whisper model size (default: large-v3-turbo)
        language: Force language (None for auto-detect)
    
    Returns:
        Path to the generated VTT file
    """
    from faster_whisper import WhisperModel
    try:
        from faster_whisper import BatchedInferencePipeline
    except ImportError:
        BatchedInferencePipeline = None
    
    input_path = Path(input_path)
    output_path = Path(output_path)
    work_dir = output_path.parent
    
    print(f"🎤 Starting transcription with {model_size}...")
    
    # Extract audio to WAV for optimal whisper performance
    audio_path = work_dir / "transcribe_audio.wav"
    print("📢 Extracting audio...")
    extract_audio(input_path, audio_path)
    
    # Load model with GPU acceleration
    # Use float16 for faster inference on GPU
    print(f"🧠 Loading Whisper model: {model_size}...")
    model = WhisperModel(
        model_size,
        device="cuda",
        compute_type="float16",
    )
    
    # Transcribe
    print("🔊 Transcribing audio...")
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
    
    detected_lang = info.language
    print(f"🌐 Detected language: {detected_lang} (probability: {info.language_probability:.2%})")
    
    # Write VTT file
    print(f"📝 Writing VTT to {output_path}...")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        
        cue_index = 1
        for segment in segments:
            for cue_start, cue_end, text in iter_subtitle_cues(segment):
                start = format_timestamp(cue_start)
                end = format_timestamp(cue_end)
                f.write(f"{cue_index}\n")
                f.write(f"{start} --> {end}\n")
                f.write(f"{text}\n\n")
                cue_index += 1
    
    # Cleanup temp audio
    if audio_path.exists():
        audio_path.unlink()
    
    print(f"✅ Transcription complete: {cue_index - 1} cues generated")
    return output_path
