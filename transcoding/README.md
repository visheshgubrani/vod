# openvod_transcoder

The shared OpenVOD processing engine, plus the self-hosted transcoding agent.

Two entry points over one implementation:

- **`openvod_transcoder.run_pipeline(...)`** — probe, plan, encode, package,
  validate and inventory a source. Used by the Modal GPU runner
  (`transcoding/main.py`) and by the self-hosted agent.
- **`openvod-transcoder`** — the agent CLI: `pair`, `doctor`, `run`, `import`,
  `jobs`, `retry`, `cancel`, `capabilities`, `rotate`.

```bash
pip install -e .            # engine + agent (needs only `requests`)
pip install -e '.[s3]'      # ...plus the Modal S3 transfer path
openvod-transcoder doctor --full
```

## Design rules

1. **Importing it costs nothing.** No Modal, no CUDA, no boto3, no Whisper, no R2
   credentials at import time. Optional dependencies load inside the feature that
   needs them, so `import openvod_transcoder` works on a bare machine.
   `tests/test_engine_isolation.py` enforces this in a subprocess with the
   optional packages blocked outright.
2. **The engine never authenticates to anything.** Transfers arrive as a
   parameter. That is what makes "the self-hosted agent holds no storage
   credentials" a property of the design rather than a promise in a document.
3. **Failures are typed** (`errors.py`), and the taxonomy separates the failures a
   different encoder could fix from the ones it could not.
4. **Hardware is proven, not assumed.** `encoding/probe.py` runs real encodes.
   `ffmpeg -hwaccels` lists compile-time support, which is not the same thing.

See `docs/self-hosted-transcoding.md` and `docs/delivery-contract.md` at the
repository root for the operator-facing and protocol-facing views.

## Tests

```bash
cd transcoding
.venv/bin/python -m pytest          # 299 pass, 2 skip (Shaka not installed here)
```

The two skips are the full-pipeline assertions that need Shaka Packager. The
real-media suite runs real FFmpeg encodes for every required media shape and is
what found the 4:4:4 / `-profile:v high` incompatibility documented in
`encoding/backends.py`.
