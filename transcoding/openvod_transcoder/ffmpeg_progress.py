"""
Real FFmpeg progress, and the stall detector built on it.

Modal's one-hour wall-clock deadline does not exist for a self-hosted job: a CPU
encode of a lecture is legitimately slow, and killing it at 60 minutes would be
wrong. What *is* wrong is a wedged encoder, so the local path needs a signal
that separates the two. That signal is forward progress in FFmpeg's own
`-progress` stream — not elapsed time, and not the heartbeat (whose thread can
be perfectly healthy while the encoder is stuck).

Parsing notes that matter:

- ``out_time_ms`` in FFmpeg's progress output is **microseconds**, despite the
  name. Reading it as milliseconds makes a 10-minute encode look like 7 days.
  ``out_time_us`` is the correctly named field and is preferred when present.
- ``out_time`` is a human timestamp and the fallback when neither numeric field
  is usable.
- ``progress=end`` terminates the stream. A run that exits without it and
  without a zero exit status is a failure even when some progress was seen.
"""
from __future__ import annotations

import re
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable, List, Optional

from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.errors import ERROR_STALLED, CancelledError, TranscodeError

_TIMESTAMP = re.compile(r"^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$")

# How often FFmpeg is asked for a progress block. 1s is fine-grained enough for
# a useful ETA and coarse enough not to matter for throughput.
PROGRESS_INTERVAL_SECONDS = 1.0


def parse_timestamp(value: str) -> Optional[float]:
    """'01:02:03.5' -> 3723.5. ``None`` when unparseable or negative."""
    match = _TIMESTAMP.match((value or "").strip())
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    try:
        total = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except ValueError:
        return None
    return total if total >= 0 else None


@dataclass
class FfmpegProgress:
    """One decoded progress block from FFmpeg."""
    out_time_seconds: Optional[float] = None
    frame: Optional[int] = None
    speed: Optional[float] = None
    ended: bool = False
    dropped_frames: Optional[int] = None

    @property
    def usable(self) -> bool:
        """True when this block says anything about media position."""
        return self.out_time_seconds is not None or self.frame is not None


def parse_progress_kv(lines: List[str]) -> FfmpegProgress:
    """
    Decode one ``key=value`` progress block.

    Pure, so the awkward parts — the ``out_time_ms`` misnomer, ``speed=N/A``,
    ``progress=end`` — are checked against literals rather than against a real
    encode.
    """
    raw: dict[str, str] = {}
    for line in lines:
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        raw[key.strip()] = value.strip()

    result = FfmpegProgress()

    if raw.get("progress", "").lower() == "end":
        result.ended = True

    # Prefer the correctly named microsecond field, then the legacy misnomer.
    for key in ("out_time_us", "out_time_ms"):
        value = raw.get(key)
        if value is None:
            continue
        try:
            micros = float(value)
        except ValueError:
            continue
        result.out_time_seconds = max(0.0, micros / 1_000_000.0)
        break

    if result.out_time_seconds is None and "out_time" in raw:
        result.out_time_seconds = parse_timestamp(raw["out_time"])

    if "frame" in raw:
        try:
            result.frame = int(float(raw["frame"]))
        except ValueError:
            pass

    if "drop_frames" in raw:
        try:
            result.dropped_frames = int(float(raw["drop_frames"]))
        except ValueError:
            pass

    speed = raw.get("speed", "")
    if speed and speed != "N/A" and speed.endswith("x"):
        try:
            result.speed = float(speed[:-1])
        except ValueError:
            result.speed = None

    return result


def progress_fraction(out_time_seconds: Optional[float], duration: Optional[float]) -> float:
    """Position as a 0..1 fraction. Unknown duration yields 0.0."""
    if not out_time_seconds or not duration or duration <= 0:
        return 0.0
    return min(1.0, max(0.0, out_time_seconds / duration))


@dataclass
class StallPolicy:
    """
    How long a silent encoder is tolerated before the job is declared stalled.

    Zero disables the check. The default is generous because the *first* frame of
    a long, high-bitrate source can legitimately take minutes: a 4K HDR remux
    over a network mount buffers before it emits anything, and killing that would
    turn a slow machine into a failing one.
    """
    timeout_seconds: float = 900.0

    @property
    def enabled(self) -> bool:
        return self.timeout_seconds > 0


class StallError(TranscodeError):
    def __init__(self, message: str) -> None:
        super().__init__(ERROR_STALLED, message)


def run_ffmpeg(
    cmd: List[str],
    *,
    label: str,
    duration: Optional[float] = None,
    on_progress: Optional[Callable[[FfmpegProgress, float], None]] = None,
    cancellation: Optional[CancellationToken] = None,
    stall: Optional[StallPolicy] = None,
) -> subprocess.CompletedProcess:
    """
    Run FFmpeg, decoding ``-progress pipe:1`` and enforcing cancellation + stall.

    The command's own ``-progress``/``-nostats`` arguments are appended here so
    every call site gets identical behaviour; callers must not add their own.

    Raises:
        CancelledError  when the token trips (subprocess is terminated first).
        StallError      when no forward progress is seen within the window.
        RuntimeError    on a non-zero exit.
    """
    policy = stall or StallPolicy()
    token = cancellation or CancellationToken()

    full_cmd = [*cmd, "-progress", "pipe:1", "-nostats"]
    print(f"[FFMPEG] {label}: {' '.join(full_cmd[:4])}...")
    started = time.monotonic()

    process = subprocess.Popen(
        full_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    last_activity = time.monotonic()
    last_out_time = -1.0
    stderr_lines: List[str] = []
    state = {"stall_reason": ""}

    def _drain_stderr() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            stderr_lines.append(line.rstrip())
            if len(stderr_lines) > 200:
                del stderr_lines[0]

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True, name=f"ffmpeg-{label}")
    stderr_thread.start()

    def _terminate() -> None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

    block: List[str] = []
    assert process.stdout is not None
    try:
        for line in process.stdout:
            stripped = line.strip()

            if token.cancelled:
                _terminate()
                raise CancelledError(token.reason)

            if policy.enabled and (time.monotonic() - last_activity) > policy.timeout_seconds:
                state["stall_reason"] = (
                    f"no encoder progress for {policy.timeout_seconds:.0f}s "
                    f"(last position {last_out_time:.1f}s)"
                )
                _terminate()
                break

            if not stripped:
                continue
            block.append(stripped)

            # A block ends at `progress=`; decode and reset.
            if stripped.startswith("progress="):
                decoded = parse_progress_kv(block)
                block = []
                if decoded.out_time_seconds is not None and decoded.out_time_seconds > last_out_time:
                    last_out_time = decoded.out_time_seconds
                    last_activity = time.monotonic()
                elif decoded.frame is not None:
                    # Audio-only and some filter graphs never advance out_time;
                    # a moving frame counter is still forward progress.
                    last_activity = time.monotonic()
                if on_progress is not None:
                    on_progress(decoded, progress_fraction(decoded.out_time_seconds, duration))
    finally:
        process.wait()
        stderr_thread.join(timeout=5)

    elapsed = time.monotonic() - started
    tail = "\n".join(stderr_lines[-50:])

    if state["stall_reason"]:
        raise StallError(f"{label}: {state['stall_reason']}\nSTDERR:\n{tail}")

    if token.cancelled:
        raise CancelledError(token.reason)

    if process.returncode != 0:
        raise RuntimeError(
            f"{label} failed in {elapsed:.1f}s (exit={process.returncode}).\nSTDERR:\n{tail}"
        )

    print(f"[FFMPEG] {label}: completed in {elapsed:.1f}s")
    return subprocess.CompletedProcess(full_cmd, process.returncode, "", tail)
