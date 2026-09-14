"""
Real FFmpeg progress, and the watchdog built on it.

Modal's one-hour wall-clock deadline does not exist for a self-hosted job: a CPU
encode of a lecture is legitimately slow, and killing it at 60 minutes would be
wrong. What *is* wrong is a wedged encoder, so the local path needs a signal
that separates the two. That signal is forward progress in FFmpeg's own
`-progress` stream — not elapsed time, and not the heartbeat (whose thread can
be perfectly healthy while the encoder is stuck).

Two properties of this module were added after a real failure and are worth
stating plainly, because the obvious implementation has neither:

1. **The watchdog does not depend on stdout.** An earlier version evaluated
   cancellation and the stall deadline *inside* the loop that read FFmpeg's
   stdout, so a process that stopped emitting output — precisely the process
   the stall detector exists for — was never noticed. Output is now drained by a
   reader thread into a queue, and the controlling thread always regains control
   within ``poll_interval`` to check the token and the deadline.
2. **Only movement resets the deadline.** Progress counts when the timestamp or
   the frame counter goes *past* the best value seen so far. Repeated identical
   blocks are not progress, however many of them arrive.

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

import queue
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable, List, Optional

from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.encoding.failures import build_process_error
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


def advance_progress(
    best_time: Optional[float],
    best_frame: Optional[int],
    decoded: FfmpegProgress,
) -> "tuple[bool, Optional[float], Optional[int]]":
    """
    Fold one progress block into the running high-water marks.

    Returns ``(moved, best_time, best_frame)``. ``moved`` is True only when this
    block says something *new*: a timestamp past the previous best, or a frame
    counter past the previous best. That is the single rule that keeps a wedged
    encoder — one repeating its last position forever — from holding the stall
    watchdog open.
    """
    moved = False

    if decoded.out_time_seconds is not None:
        if best_time is None or decoded.out_time_seconds > best_time:
            best_time = decoded.out_time_seconds
            moved = True

    if decoded.frame is not None:
        if best_frame is None or decoded.frame > best_frame:
            best_frame = decoded.frame
            moved = True

    return moved, best_time, best_frame


# How long a terminated process is given to exit before it is killed, and how
# long the killed process is given before we stop waiting: ten seconds each, the
# grace period the pipeline has always used.
TERMINATION_GRACE_SECONDS = 10.0

# How often the controlling thread wakes to check cancellation and the stall
# deadline while FFmpeg is silent. Short enough to react promptly, long enough
# not to spin.
WATCHDOG_POLL_SECONDS = 0.25

_EOF = object()


def run_ffmpeg(
    cmd: List[str],
    *,
    label: str,
    duration: Optional[float] = None,
    on_progress: Optional[Callable[[FfmpegProgress, float], None]] = None,
    cancellation: Optional[CancellationToken] = None,
    stall: Optional[StallPolicy] = None,
    clock: Optional[Callable[[], float]] = None,
    poll_interval: float = WATCHDOG_POLL_SECONDS,
) -> subprocess.CompletedProcess:
    """
    Run FFmpeg, decoding ``-progress pipe:1`` and enforcing cancellation + stall.

    The command's own ``-progress``/``-nostats`` arguments are appended here so
    every call site gets identical behaviour; callers must not add their own.

    ``clock`` is injectable so the watchdog's arithmetic can be tested without
    patching the global ``time`` module that every other thread also reads.

    Raises:
        CancelledError        when the token trips (subprocess is terminated first).
        StallError            when no forward progress is seen within the window.
        FFmpegProcessError    on a non-zero exit, carrying the exit status and a
                              bounded stderr tail already classified into a
                              failure kind (see ``encoding.failures``).
    """
    policy = stall or StallPolicy()
    token = cancellation or CancellationToken()
    now = clock or time.monotonic

    full_cmd = [*cmd, "-progress", "pipe:1", "-nostats"]
    print(f"[FFMPEG] {label}: {' '.join(full_cmd[:4])}...")
    started = now()

    process = subprocess.Popen(
        full_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    blocks: "queue.Queue[object]" = queue.Queue()
    stderr_lines: List[str] = []

    def _read_progress() -> None:
        """Drain stdout into decoded blocks. Runs on its own thread."""
        assert process.stdout is not None
        block: List[str] = []
        try:
            for line in process.stdout:
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("progress="):
                    blocks.put(parse_progress_kv([*block, stripped]))
                    block = []
                    continue
                block.append(stripped)
        finally:
            blocks.put(_EOF)

    def _drain_stderr() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            stderr_lines.append(line.rstrip())
            if len(stderr_lines) > 200:
                del stderr_lines[0]

    reader = threading.Thread(target=_read_progress, daemon=True, name=f"ffmpeg-out-{label}")
    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True, name=f"ffmpeg-err-{label}")
    reader.start()
    stderr_thread.start()

    def _terminate() -> None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=TERMINATION_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=TERMINATION_GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    print(f"[FFMPEG] {label}: process ignored SIGKILL")

    last_activity = now()
    best_time: Optional[float] = None
    best_frame: Optional[int] = None
    stall_reason = ""
    cancelled = False

    try:
        while True:
            # Checked before every wait, so a silent process is still stopped.
            if token.cancelled:
                _terminate()
                cancelled = True
                break

            if policy.enabled and (now() - last_activity) > policy.timeout_seconds:
                stall_reason = (
                    f"no encoder progress for {policy.timeout_seconds:.0f}s "
                    f"(last position {best_time if best_time is not None else -1.0:.1f}s)"
                )
                _terminate()
                break

            try:
                item = blocks.get(timeout=poll_interval)
            except queue.Empty:
                continue

            if item is _EOF:
                # A process can close stdout before exiting. Keep supervising
                # it rather than blocking forever in wait() below.
                if process.poll() is not None:
                    break
                continue

            decoded = item
            assert isinstance(decoded, FfmpegProgress)
            moved, best_time, best_frame = advance_progress(best_time, best_frame, decoded)
            if moved:
                last_activity = now()
            if on_progress is not None:
                on_progress(decoded, progress_fraction(decoded.out_time_seconds, duration))
    finally:
        # Also terminate on callback/reader errors; a failed progress sink must
        # not leave an encoder holding its device and output files.
        _terminate()
        reader.join(timeout=5)
        stderr_thread.join(timeout=5)

    elapsed = now() - started
    tail = "\n".join(stderr_lines[-50:])

    if cancelled or token.cancelled:
        raise CancelledError(token.reason)

    if stall_reason:
        raise StallError(f"{label}: {stall_reason}\nSTDERR:\n{tail}")

    if process.returncode != 0:
        raise build_process_error(
            stderr=tail,
            returncode=process.returncode,
            operation=label,
            message=f"{label} failed in {elapsed:.1f}s (exit={process.returncode}).",
        )

    print(f"[FFMPEG] {label}: completed in {elapsed:.1f}s")
    return subprocess.CompletedProcess(full_cmd, process.returncode, "", tail)
