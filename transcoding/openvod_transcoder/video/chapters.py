"""
AI Chapters Generation Module - Using Groq LLM

Generates video chapters by analyzing Whisper transcripts using Groq's
Llama 3 models. Uses adaptive model selection based on video duration.
"""
import os
import re
import json
from typing import Optional

def clean_vtt_for_llm(vtt_content: str) -> str:
    """
    Optimized VTT Cleaner for LLM Context Windows.
    - Removes 'WEBVTT', cue numbers, and extra timestamps.
    - Merges text into 10-second 'paragraph blocks' to save tokens.
    - Fixes the 'Multi-line Text' bug from previous versions.
    """
    lines = vtt_content.strip().split('\n')
    result = []
    
    current_time_str = None
    current_text_block = []
    
    # Track time to group sentences (Debouncing)
    last_captured_seconds = -15 
    
    for line in lines:
        line = line.strip()
        
        # 1. Skip Metadata (Headers, Cue Numbers)
        if not line or line == 'WEBVTT' or line.isdigit():
            continue
            
        # 2. Match Timestamp Line (e.g., "00:00:04.430 --> ...")
        # 2. Match Timestamp Line
        timestamp_match = re.match(r'(\d{2}):(\d{2}):(\d{2})\.\d{3}', line)
        if timestamp_match:
            hours, minutes, seconds = map(int, timestamp_match.groups())
            total_seconds = hours * 3600 + minutes * 60 + seconds
            
            # Logic: Only flush if we are jumping forward significantly (>10s)
            if total_seconds - last_captured_seconds >= 10:
                # 1. Flush the previous block (if any)
                if current_text_block and current_time_str:
                    result.append(f"{current_time_str} {' '.join(current_text_block)}")
                    current_text_block = [] # Reset buffer

                # 2. Update the label for the NEW block
                if total_seconds >= 3600:
                    current_time_str = f"[{hours:02d}:{minutes:02d}:{seconds:02d}]"
                else:
                    current_time_str = f"[{minutes:02d}:{seconds:02d}]"
                last_captured_seconds = total_seconds
            
            # If < 10s, we DO NOT flush. We keep accumulating text under the old timestamp.
            continue
            
        # 4. Capture Text (Accumulate multi-line cues)
        if current_time_str:
            # Remove HTML tags if present (e.g. <i>Text</i>)
            clean_line = re.sub(r'<[^>]+>', '', line)
            current_text_block.append(clean_line)

    # Don't forget the very last block!
    if current_text_block and current_time_str:
        result.append(f"{current_time_str} {' '.join(current_text_block)}")

    return '\n'.join(result)

def parse_time_to_seconds(time_str: str) -> float:
    """
    Parse time string to seconds.
    Accepts formats: "MM:SS", "HH:MM:SS", or just seconds as number.
    """
    time_str = str(time_str).strip()
    
    # Already a number
    if time_str.replace('.', '').isdigit():
        return float(time_str)
    
    parts = time_str.split(':')
    if len(parts) == 2:
        # MM:SS
        return int(parts[0]) * 60 + float(parts[1])
    elif len(parts) == 3:
        # HH:MM:SS
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    
    return 0.0


def generate_chapters(
    vtt_content: str,
    duration_seconds: float,
    groq_api_key: Optional[str] = None,
) -> list[dict]:
    """
    Generate video chapters using Groq LLM.
    
    Args:
        vtt_content: Raw VTT subtitle content
        duration_seconds: Total video duration in seconds
        groq_api_key: Groq API key (defaults to GROQ_API_KEY env var)
    
    Returns:
        List of chapters: [{startTime: float, endTime: float, title: str}]
    """
    from groq import Groq
    
    api_key = groq_api_key or os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise ValueError("GROQ_API_KEY not provided")
    
    # Clean VTT to reduce tokens
    cleaned_transcript = clean_vtt_for_llm(vtt_content)
    
    # Adaptive model selection based on duration
    # < 30 min: 8b model (faster, cheaper)
    # >= 30 min: 70b model (better context handling)
    if duration_seconds < 1800:  # 30 minutes
        model = "llama-3.1-8b-instant"
    else:
        model = "llama-3.3-70b-versatile"
    
    print(f"📝 Generating chapters with {model} for {duration_seconds/60:.1f}min video...")
    
    # Build prompt - only ask for startTime + title
    system_prompt = """You are a video chapter generator. Analyze the transcript and identify logical topic segments.

Rules:
1. Output ONLY valid JSON array
2. Each chapter needs: startTime (in "MM:SS" or "HH:MM:SS" format) and title (brief, descriptive)
3. First chapter should start at "00:00"
4. Create 3-10 chapters depending on content
5. Titles should be concise (2-6 words)
6. Do NOT include endTime - it will be calculated automatically

Example output:
[
  {"startTime": "00:00", "title": "Introduction"},
  {"startTime": "02:15", "title": "Setting Up the Project"},
  {"startTime": "08:30", "title": "Building the UI"}
]"""

    user_prompt = f"""Analyze this transcript and generate chapter markers:

{cleaned_transcript}

Output ONLY the JSON array, no explanation."""

    client = Groq(api_key=api_key)
    
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0.3,  # Lower temperature for more consistent output
        max_completion_tokens=1024,
    )
    
    # Parse LLM response
    content = response.choices[0].message.content.strip()
    
    # Extract JSON array from response (handle markdown code blocks)
    json_match = re.search(r'\[[\s\S]*\]', content)
    if not json_match:
        raise ValueError(f"No JSON array found in LLM response: {content[:200]}")
    
    raw_chapters = json.loads(json_match.group())
    
    # Validate and convert to proper format
    chapters = []
    for ch in raw_chapters:
        start_time = parse_time_to_seconds(ch.get("startTime", "0"))
        title = str(ch.get("title", "Untitled")).strip()
        
        if title:
            chapters.append({
                "startTime": start_time,
                "title": title
            })
    
    # Sort by startTime
    chapters.sort(key=lambda x: x["startTime"])
    
    # Ensure first chapter starts at 0
    if chapters and chapters[0]["startTime"] > 0:
        chapters[0]["startTime"] = 0
    
    # Calculate endTime programmatically (LLMs are bad at time math)
    for i, chapter in enumerate(chapters):
        if i < len(chapters) - 1:
            chapter["endTime"] = chapters[i + 1]["startTime"]
        else:
            chapter["endTime"] = duration_seconds
    
    print(f"✅ Generated {len(chapters)} chapters")
    return chapters
