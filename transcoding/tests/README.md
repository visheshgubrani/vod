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
into the unit tests.

Tests never shell out to Modal, and never import it: the engine must import and
run on a machine where Modal does not exist (`test_engine_isolation.py` proves
this in a subprocess with the optional packages blocked outright).

## Seams (pre-agreed)

| Module | Interface under test |
| --- | --- |
| `openvod_transcoder.video.analysis` | ffprobe JSON → metadata (rotation, audio-only, HDR, fps clamps, bit depth) |
| `openvod_transcoder.planning` | `plan_renditions` decisions (no upscale, source-sized sub-rung, vertical cap, explicit rungs) |
| `openvod_transcoder.encoding.backends` | pure FFmpeg argument builders (filters, encoder args, GOP, levels) |
| `openvod_transcoder.encoding.probe` | `classify_probe_failure`, `parse_*` inventory parsers, probe verdicts |
| `openvod_transcoder.encoding.selection` | `select_chain` + `FallbackState` (explicit never silently becomes CPU; bad media never falls back) |
| `openvod_transcoder.ffmpeg_progress` | progress decoding (`out_time_ms` is microseconds!), stall detection, cancellation |
| `openvod_transcoder.progress` | stage weighting, per-rendition aggregation, activity clock |
| `openvod_transcoder.paths` | traversal, symlink escape, special files, root-relative display |
| `openvod_transcoder.snapshot` | copy/reflink, hashing, change detection, never a hardlink, original untouched |
| `openvod_transcoder.result` | artifact roles, inventory shape, completion payload |
| `openvod_transcoder.transfer.*` | publication order, content types, grant expiry and refusal to renew |
| `openvod_transcoder.pipeline` | orchestration against injected seams: staging, fallback, cancellation, validation |
| `openvod_transcoder.agent.*` | journal durability and reuse keys, config parsing, API error mapping |
| `openvod_transcoder.utils.network` | heartbeat is strictly non-fatal; callback retry policy |
| `openvod_transcoder.agent.runner` | job-scoped lease probes, lease deadline, `stop: true`, paged grants/verification |
| `openvod_transcoder.agent.journal` | cross-attempt reuse keyed on source hash + plan fingerprint |
| `openvod_transcoder.options` | wire (camelCase) → engine mapping; agent machine constraints |

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
```
