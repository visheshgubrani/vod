# Transcoding tests (pytest)

Pure-logic unit tests for the Modal pipeline. Tests never shell out to ffmpeg,
shaka, or Modal: subprocess runners and network callbacks are injected at seams.

## Seams (pre-agreed)

| Module | Interface under test |
| --- | --- |
| `video/analysis.py` | ffprobe JSON → `Metadata` (rotation, audio-only, HDR, fps clamps) |
| `video/analysis.py` | `select_optimal_ladder` decisions (vertical cap, no upscale, source-of-truth ladders) |
| `utils/network.py` | heartbeat is strictly non-fatal (failures swallowed, never raise) |
| `utils/network.py` | callback retry policy (no 4xx retry, jitter, final-failure logging) |
| `main.py` payload builders | typed error codes and result payload schemas |

## Rules

- Red → green, one vertical slice per cycle.
- Expected values from worked examples (e.g. a known ffprobe JSON blob → known
  Metadata), never re-derived from code.

## Commands

```bash
python -m pytest tests        # inside transcoding/, using the local venv
# or: .venv/bin/python -m pytest tests
```
