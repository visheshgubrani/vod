# Local transcoding

ClipMux runs new transcode jobs on the deployment's single local worker or on
Modal. The choice is set for the deployment with `TRANSCODE_PROVIDER=local` or
`TRANSCODE_PROVIDER=modal`; accepted jobs keep the provider they were created
with. Local jobs from every organization share the same worker and queue.

## Requirements

| | Local worker | Modal |
| --- | --- | --- |
| Linux host with Docker Compose | required for the bundled worker | not required |
| Cloudflare R2 + delivery Worker | required for playback | required for playback |
| Raw upload bucket | only for browser/SDK uploads | required when uploads are enabled |
| Modal account | not required | required |

The local worker needs no organization pairing and can start before an
organization exists. A raw bucket is needed for browser uploads, not for files
already mounted on the host. The transcoded bucket and its R2 credentials are
needed by both providers.

## Configure a local deployment

The setup wizard defaults fresh deployments to local encoding. It generates one
32-byte `LOCAL_TRANSCODER_SECRET`, reuses it on reruns, writes it to the selected
configuration target, enables the Compose `transcoder` profile, builds the local
image, and waits for a worker heartbeat. Modal setup leaves that profile off and
does not build the media image.

For a manual Compose deployment, set these in the root `.env` (the same values
are used by the API and worker):

```dotenv
TRANSCODE_PROVIDER=local
LOCAL_TRANSCODE_ENABLED=true
LOCAL_TRANSCODER_SECRET=<32-byte random secret>
UPLOADS_ENABLED=false             # optional; also avoids needing a raw bucket
TRANSCODED_BUCKET_NAME=clipmux-transcoded
```

Set `LOCAL_TRANSCODER_SECRET` to at least 32 characters, then start the worker
with the API and database:

```bash
docker compose --profile transcoder up -d --build
```

The Compose worker mounts the media directory read-only and keeps its journal
and scratch space in a persistent volume. Only one daemon is supported; the
shared state volume has an exclusive process lock, so a second daemon exits with
a clear error. `GET /health/config` reports `transcode.defaultProvider` and the
secret-free `transcode.localWorker.online` status.

For local development, put `TRANSCODE_PROVIDER=local` and the same
`LOCAL_TRANSCODER_SECRET` in `server/.dev.vars`. Start the API with `pnpm dev`,
then start the worker explicitly with the same secret and an API URL reachable
from its process, for example:

```bash
cd transcoding
LOCAL_TRANSCODER_SECRET='<same secret>' CLIPMUX_API_URL=http://localhost:8787 \
  .venv/bin/clipmux-transcoder run
```

Development commands do not start the worker automatically.

## Optional host-folder import

Ordinary uploads from any organization can use the local worker without extra
organization configuration. Host-folder browsing and import are separate and
opt-in: set `LOCAL_IMPORT_ORG_ID` to the ID of an existing organization. Only
owners and admins of that organization can browse the configured roots and
register files; imports and API-key submissions are restricted to that same
organization. If the variable is unset or names no existing organization,
folder import stays disabled while normal uploads continue to transcode.

Configure the folders mounted into the worker with `CLIPMUX_ROOTS` as
`NAME:PATH` pairs. The container receives them read-only. Symlinks outside a
configured root, absolute paths from the browser, and changed file identities
are rejected.

```bash
CLIPMUX_ROOTS=media:/media,course-archive:/mnt/archive
clipmux-transcoder doctor
clipmux-transcoder import /srv/media/course/lesson-01.mp4 --policy signed
```

Run `doctor` inside the worker environment to check media tools and perform a
read-only credential probe. It does not update worker liveness. The dashboard's
**Encoding** page shows the shared worker and the active organization's own
queue; folder browsing appears only for an authorized owner/admin while the
local worker is online.

### Worker settings

| Setting | Default | Notes |
| --- | --- | --- |
| `CLIPMUX_API_URL` | `http://api:4080` in Compose | Must resolve from inside the worker container |
| `CLIPMUX_ROOTS` | `media:/media` | `NAME:PATH` pairs; these are the only host paths the worker can read |
| `CLIPMUX_SCRATCH_DIR` | `/var/lib/clipmux-transcoder/scratch` | Needs roughly 2× the source size |
| `CLIPMUX_CAPACITY_JOBS` | `1` | Total parallel jobs on this machine |
| `CLIPMUX_CAPACITY_RENDITIONS` | `1` | Parallel rendition encodes within a job |
| `CLIPMUX_ENCODER` | `auto` | `auto`, `cpu`, `nvenc`, `vaapi` (optionally `nvenc:1`) |
| `CLIPMUX_STALL_TIMEOUT_SECONDS` | `900` | Kill a wedged encoder; no wall-clock job limit |
| `CLIPMUX_PROGRESS_BEAT_SECONDS` | `15` | Dashboard progress cadence |
| `CLIPMUX_HEARTBEAT_SECONDS` | `30` | Worker liveness cadence |

## Switching providers

`LOCAL_TRANSCODE_ENABLED=false` rejects new local jobs and leaves already
accepted local work available to drain. When the managed setup changes from
local to Modal, it checks that no local jobs remain queued or active before
rebuilding, then stops the Compose worker and removes only the `transcoder`
profile from `COMPOSE_PROFILES`. Cancel outstanding jobs from **Encoding** or
let them finish before rerunning setup. The provider change never reroutes an
accepted job.

## AI subtitles and chapters

AI enrichment support depends on the chosen worker image and configuration. See
[known gaps](./known-gaps.md) for current local limitations and the supported
Modal setup.

## Hardware

FFmpeg lists what it was *compiled* with, which is not the same as what works.
Every backend below is verified with a real encode of two synthetic frames
before it is offered, and the chosen backend is re-verified against your actual
source with a short preflight encode at the planned rendition size before a job
commits to it. The preflight is what turns "the encoder works" into "the encoder
works for *this file*": pixel format, bit depth, rotation and HDR handling are
properties of the source, and a synthetic frame cannot see any of them.

| Backend | Encoder | Requirements |
| --- | --- | --- |
| CPU | `libx264` | none beyond the image |
| NVIDIA | `h264_nvenc` | host driver >= 530.41.03 + NVIDIA Container Toolkit |
| AMD | `h264_vaapi` | `/dev/dri/renderD128` + Mesa VAAPI |

The image ships a source-built FFmpeg pinned in
`transcoding/toolchain/versions.env` (see `docs/transcoding-toolchain.md`). It is
not the distribution's package: that build's `scale_cuda` lacked the `format`
option the NVIDIA scaling path passes, which is a build-time property of
FFmpeg's CUDA filters and therefore only fixable by building them.

### The three execution paths

| Path | Decode | Transform and scale | Encode |
| --- | --- | --- | --- |
| Full GPU | GPU | GPU | GPU |
| Hybrid | CPU | CPU | GPU |
| CPU | CPU | CPU | `libx264` |

The full-GPU path is only used when the source's own properties allow it —
H.264/HEVC, 8-bit, 4:2:0, no rotation, no HDR — *and* the preflight proved this
source decodes and filters on the device. Everything else takes the hybrid path,
which is the same hardware encoder without the hardware filter graph. HDR is
deliberately always hybrid: there is no GPU tone-mapping filter we are willing to
depend on, and a slower correct picture beats a fast wrong one.

**NVIDIA.** Pass the `video` driver capability *in addition to* compute and
utility. Omitting it is the common failure: the driver is visible, but no encode
session can be created.

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu, video]
```

**AMD.** VAAPI is the supported Linux path. Pass the render device and the
`video` group:

```yaml
devices:
  - /dev/dri/renderD128:/dev/dri/renderD128
group_add:
  - video
```

### Fallback, and when it does not happen

With `CLIPMUX_ENCODER=auto`: verified NVENC → verified VAAPI → CPU. A hardware
path that fails on your specific source first retries with software
decode/filter and the *same* hardware encoder; only if that fails does it reach
the CPU. Every fallback is recorded on the job, so "why was this slow?" has an
answer.

Each rendition keeps its **own** attempt state. A GPU limit hit by the 1080p rung
does not move the 720p rung onto a backend it never tried, and the job reports
`mixed` as its backend when a ladder finishes across more than one encoder —
per-rendition detail says which rung was which. A backend that is *proven*
unusable (no device node, no encoder session) is skipped by every remaining
rendition instead of being re-discovered four times. Verified GPU session
exhaustion is serialized and retried once on the same backend before any
fallback.

With an explicit backend (`nvenc`, `vaapi`), there is **no** silent fallback: if
the GPU is unusable the job fails with the reason and the remedy. Choosing a GPU
and quietly getting a CPU encode is the outcome an operator least wants.

Fallback never happens for bad media, a missing file, a full disk, a failed
packaging run or a cancelled job — re-running those elsewhere changes nothing.
The distinction is made by classifying FFmpeg's own stderr at the encoding
boundary, so the failure that motivated all of this (`scale_cuda` rejecting its
`format` option) is recognised as a *filter* failure and retried on the hybrid
path, while `moov atom not found` fails immediately.

---

## Operating it

| Situation | Behaviour |
| --- | --- |
| Worker offline before starting | job stays queued, dashboard shows *waiting for worker* |
| Worker restarts | reconciles with the API before resuming; superseded attempts are abandoned |
| Network drops mid-upload | retried with backoff while the lease is valid |
| Lease lost | work stops **before** expiry; nothing uploads or finalizes under lost ownership |
| Partial encode | only the missing rendition is re-encoded |
| Partial upload | only the missing objects are re-sent; nothing is re-encoded |
| Original moved or changed | `SOURCE_MISSING` / `SOURCE_CHANGED`; re-select the file. Retries do **not** consume the attempt budget |
| Job cancelled or video deleted | work stops, late completion is rejected, artifacts are scheduled for cleanup |

Original files are never modified or deleted. The worker copies (or reflinks) the
source before encoding, and removes only its own copy.

To pause new local work without interrupting accepted jobs, set
`LOCAL_TRANSCODE_ENABLED=false`. Accepted jobs continue to drain and can be
cancelled from the dashboard.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `encoder backend 'nvenc' ... is not usable` | missing `video` capability, or the host driver is older than the codec |
| `encoder backend 'vaapi' ... is not usable` | render device not passed through, or the user is not in the `video` group |
| Job stuck at *waiting for worker* | no heartbeat within 90 s — check the container is running and `CLIPMUX_API_URL` is reachable from it |
| Job stuck at *source-changed* | the file was edited after registration; re-select it |
| `SOURCE_UNREADABLE` | permissions on the mount, or the file is not a regular file |
| Upload fails repeatedly | the transcoded bucket or its credentials are wrong; `doctor` does not cover object storage, by design — the worker holds no storage credentials |
