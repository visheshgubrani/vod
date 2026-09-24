# clipmux_transcoder

The shared ClipMux processing engine and the single local worker bundled with a ClipMux deployment.

Two entry points over one implementation:

- **`clipmux_transcoder.run_pipeline(...)`** — probe, plan, encode, package,
  validate and inventory a source. Used by the Modal GPU runner
  (`transcoding/main.py`) and by the local worker.
- **`clipmux-transcoder`** — the local worker CLI: `run`, read-only `doctor`,
  configured-organization `import`, `capabilities`, and `version`.

```bash
pip install -e .            # engine + local worker (needs only `requests`)
pip install -e '.[s3]'      # ...plus the Modal S3 transfer path
clipmux-transcoder doctor --full
```

## Design rules

1. **Importing it costs nothing.** No Modal, no CUDA, no boto3, no Whisper, no R2
   credentials at import time. Optional dependencies load inside the feature that
   needs them, so `import clipmux_transcoder` works on a bare machine.
   `tests/test_engine_isolation.py` enforces this in a subprocess with the
   optional packages blocked outright.
2. **The engine never authenticates to anything.** Transfers arrive as a
   parameter. That is what makes "the local worker holds no storage
   credentials" a property of the design rather than a promise in a document.
3. **Failures are typed** (`errors.py`), and the taxonomy separates the failures a
   different encoder could fix from the ones it could not.
4. **Hardware is proven, not assumed.** `encoding/probe.py` runs real encodes —
   two synthetic frames once per machine, then a bounded preflight of the *actual
   source* at the planned rendition size. `ffmpeg -hwaccels` lists compile-time
   support, which is not the same thing.
5. **Every rendition owns its attempt state.** `encoding/selection.py` builds the
   chain, `pipeline.py` walks it per rendition, and the only thing shared between
   renditions is what the worker *proved* about a backend (an unusable device is
   not re-discovered once per rung).
6. **A failure is classified before it is acted on.** `encoding/failures.py` maps
   FFmpeg's stderr onto a kind (filter, decode, device, encoder, session,
   media…), which decides both the wire error code and whether a different
   encoder path could help. Packaging, corrupt media, disk exhaustion and
   cancellation never re-enter the encoder chain.

The three execution paths are full GPU, hybrid (software decode/scale, hardware
encode) and CPU. Which one a rendition takes is decided from the source's codec,
pixel format, bit depth, rotation and HDR properties plus the preflight result —
never from a file extension.

See `docs/local-transcoding.md`, `docs/transcoding-toolchain.md` and
`docs/delivery-contract.md` at the repository root for the operator-facing,
toolchain-facing and protocol-facing views.

## Tests

```bash
cd transcoding
.venv/bin/python -m pytest          # everything, skipping absent binaries
.venv/bin/python -m pytest -q -rs   # ...and say what was skipped
```

The real-media suite runs real FFmpeg encodes for every required media shape
(AV1/Opus WebM, VP9, H.264, HEVC 10-bit, HDR10, rotated, 4:2:2/4:4:4, variable
frame rate, short, silent, audio-only) and packages them with Shaka when it is
installed; it is what found the 4:4:4 / `-profile:v high` incompatibility
documented in `encoding/backends.py`. Set `CLIPMUX_REQUIRE_MEDIA_TOOLS=1` — as CI
does — to make a missing binary a failure instead of a skip.
