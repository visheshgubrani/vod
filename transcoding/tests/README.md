# Transcoding tests (pytest)

Three suites, in increasing order of what they can prove:

| Suite | Proves | Needs |
| --- | --- | --- |
| pure-logic unit tests | the values we compute are the intended ones | nothing |
| `test_real_media.py` | the FFmpeg commands we build are ones FFmpeg accepts | `ffmpeg`/`ffprobe` (auto-skipped) |
| the same file, packager classes | the whole pipeline produces playable HLS/DASH | `ffmpeg` + `packager` (auto-skipped) |

The distinction matters. A unit test can assert that our filter chain contains
`setsar=1`; only real media shows that a 4:4:4 source fails against
`-profile:v high` without an explicit `format=yuv420p`. That exact bug was found
by this suite, and it is why the real-media tests exist rather than being folded
into the unit tests. The same reasoning covers the thread bounds: FFmpeg
*ignores* options that follow the output path instead of rejecting them, so only
a test that captures the engine's own command line can prove a bound was placed
where it takes effect.

`CLIPMUX_REQUIRE_MEDIA_TOOLS=1` (set by CI, after installing FFmpeg and the
checksum-pinned Shaka) turns a missing binary into a **collection error** instead
of a skip, so a CI job that lost its toolchain cannot report a green run while
testing none of this.

Tests never shell out to Modal, and never import it: the engine must import and
run on a machine where Modal does not exist (`test_engine_isolation.py` proves
this in a subprocess with the optional packages blocked outright).

## Seams (pre-agreed)

| Module | Interface under test |
| --- | --- |
| `clipmux_transcoder.video.analysis` | ffprobe JSON → metadata (rotation, audio-only, HDR, fps clamps, bit depth) |
| `clipmux_transcoder.planning` | `plan_renditions` decisions (no upscale, source-sized sub-rung, vertical cap, explicit rungs) |
| `clipmux_transcoder.encoding.backends` | pure FFmpeg argument builders (filters, encoder args, GOP, levels, device/thread placement) |
| `clipmux_transcoder.encoding.probe` | `classify_probe_failure`, `parse_*` inventory parsers, probe verdicts, preflight commands |
| `clipmux_transcoder.encoding.failures` | FFmpeg stderr → failure kind (what may fall back, and what may not) |
| `clipmux_transcoder.encoding.selection` | `select_chain` + `build_attempt_chain` + `FallbackState` + `WorkerEncoderState` (explicit never silently becomes CPU; bad media never falls back; GPU/CPU admission) |
| `clipmux_transcoder.encoding.validation` | encoded codec/dimensions/pix_fmt/duration, and every manifest reference resolving to a packaged file |
| `clipmux_transcoder.ffmpeg_progress` | progress decoding (`out_time_ms` is microseconds!), stall detection, cancellation, watchdog cleanup |
| `clipmux_transcoder.video.transcription` | Whisper CUDA → CPU INT8 retry; a VTT is published only when complete |
| `clipmux_transcoder.progress` | stage weighting, per-rendition aggregation, activity clock, progress-beat coalescing |
| `clipmux_transcoder.paths` | traversal, symlink escape, special files, root-relative display |
| `clipmux_transcoder.snapshot` | copy/reflink, hashing, change detection, never a hardlink, original untouched |
| `clipmux_transcoder.result` | artifact roles, inventory shape, completion payload |
| `clipmux_transcoder.transfer.*` | publication order, content types, grant expiry and refusal to renew |
| `clipmux_transcoder.pipeline` | orchestration against injected seams: staging, per-rendition fallback, admission bounds, sibling cancellation, validation |
| `clipmux_transcoder.agent.*` | journal durability and reuse keys, config parsing, API error mapping |
| `clipmux_transcoder.utils.network` | heartbeat is strictly non-fatal; callback retry policy |
| `clipmux_transcoder.agent.runner` | job-scoped lease probes, lease deadline, `stop: true`, paged grants/verification |
| `clipmux_transcoder.agent.journal` | cross-attempt reuse keyed on source hash + plan fingerprint |
| `clipmux_transcoder.options` | wire (camelCase) → engine mapping; agent machine constraints; fingerprint inputs |
| `toolchain/*` (text checks) | the shared recipe stays internally consistent: pins, configure flags, verification, lockfile, image wiring |

## Rules

- Red → green, one vertical slice per cycle.
- Expected values come from worked examples (a known ffprobe blob → known
  metadata; a known source and rung → hand-computed dimensions), never re-derived
  from the code under test.
- Anything requiring real hardware (an actual NVENC or VAAPI encode) is a
  **release gate**, not a unit test: mocked capability detection cannot prove a
  driver works.

## Contracts with the other half of the system

`tests/contract_fixtures.py` generates `tests/fixtures/completion_payloads.json`
from the **real** engine, and `server/tests/lib/completionContract.test.ts`
asserts what the API makes of it. The seam between the two languages is a JSON
payload nothing type-checks, and the Modal playback-URL regression lived exactly
there: the engine began emitting output-relative paths while the API assumed
complete object keys, so every new Modal video got a URL that 404s. A Python test
regenerates the fixtures and fails on drift, so the two halves cannot silently
disagree again.

```bash
.venv/bin/python -m tests.contract_fixtures   # refresh after changing the payload
```

## Commands

```bash
cd transcoding
.venv/bin/python -m pytest              # everything, skipping absent binaries
.venv/bin/python -m pytest -q -rs       # ...and say what was skipped
.venv/bin/python -m pytest tests/test_real_media.py
CLIPMUX_REQUIRE_MEDIA_TOOLS=1 .venv/bin/python -m pytest   # as CI runs it: no silent skips
```

Two files are regression suites rather than seam suites, and are worth knowing
about before changing engine behaviour: `test_review_regressions.py` (the
defects found while reviewing the toolchain migration: CPU admission after a GPU
fallback, session-retry ordering, watchdog cleanup, sibling reaping, timeout-free
manifest validation) and `test_failures.py` (what may and may not trigger an
encoder fallback).
