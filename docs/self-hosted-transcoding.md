# Self-hosted transcoding

OpenVOD can encode videos on your own machine instead of Modal. The processing
engine is identical — same FFmpeg commands, same ladder, same packaging, same
video lifecycle — so switching providers changes *where* work runs, not what it
produces or how the API reports it.

Both paths can be active at once, and the choice is per job: an installation that
mostly uses Modal can still import a file that never leaves the building.

---

## What you need

| | Local-only install | Mixed install |
| --- | --- | --- |
| Owned machine (Linux x86-64 + Docker) | required | required |
| Cloudflare R2 + delivery Worker | required (for delivery) | required |
| Raw upload bucket | **not needed** | needed only for browser/SDK uploads |
| Modal account | **not needed** | optional |
| QStash | not needed | not needed |

A raw bucket is required by *uploading*, not by transcoding. If your only source
of video is files already on your machine, skip it.

---

## 1. Configure the API

```bash
# server/.dev.vars
TRANSCODE_PROVIDER=self-hosted
UPLOADS_ENABLED=false          # omit RAW_BUCKET_NAME entirely
ACCOUNT_ID=...                 # R2 credentials are still needed to deliver
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
TRANSCODED_BUCKET_NAME=openvod-transcoded
DELIVERY_URL=https://delivery.example.com
```

`POSTGRES`, auth secrets and the delivery URL are unchanged from the standard
setup. `GET /health/config` reports `transcode.localImport: true` once an agent
has paired and been seen.

Deploy the **API before the agent**. The agent protocol is additive, so an old
API ignores it; the reverse is not true.

---

## 2. Pair the machine

In the dashboard: **Settings → Transcoders → Pair a machine**. You get a
single-use code, valid for 15 minutes.

```bash
docker run --rm -it \
  -v /srv/media:/media:ro \
  -v openvod-scratch:/var/lib/openvod-transcoder \
  openvod-transcoder \
  pair --api https://api.example.com --code XXXX-XXXX-XX
```

Pairing runs a real encode probe first, so a machine that cannot encode fails
here rather than on your first import. The credential is written to
`/var/lib/openvod-transcoder/token` with mode `0600`.

---

## 3. Declare what the agent may read

The agent can read **only** the folders you mount and list. Everything else is
refused by path policy, including symlinks that point outside a root.

```bash
OPENVOD_ROOTS=media:/media,course-archive:/mnt/archive
```

| Setting | Default | Notes |
| --- | --- | --- |
| `OPENVOD_ROOTS` | none | `NAME:PATH` pairs; the name is what the dashboard shows |
| `OPENVOD_SCRATCH_DIR` | `/var/lib/openvod-transcoder/scratch` | needs roughly 2× the source size |
| `OPENVOD_CAPACITY_JOBS` | `1` | parallel jobs on this machine |
| `OPENVOD_CAPACITY_RENDITIONS` | `1` | parallel rendition encodes within a job |
| `OPENVOD_ENCODER` | `auto` | `auto`, `cpu`, `nvenc`, `vaapi` (optionally `nvenc:1`) |
| `OPENVOD_STALL_TIMEOUT_SECONDS` | `900` | kill a wedged encoder; no wall-clock job limit |
| `OPENVOD_FAILED_RETENTION_DAYS` | `7` | failed work directories are kept for inspection |

Mount the media read-only. The agent snapshots the file it encodes; it never
needs write access, and a container that cannot write to your library cannot
damage it.

---

## 4. Check it, then run it

```bash
docker run --rm -v /srv/media:/media:ro -v openvod-scratch:/var/lib/openvod-transcoder \
  -e OPENVOD_ROOTS=media:/media -e OPENVOD_API_URL=https://api.example.com \
  openvod-transcoder doctor --full
```

`doctor` checks, in the order a job would hit them: configuration, FFmpeg,
ffprobe and Shaka, that each folder is readable *and listable*, that scratch is
writable and has room, that an encoder really encodes, that the credential is
accepted, and — with `--full` — a complete encode and package cycle. Exit code
`0` means ready; anything else prints a `FAIL` line naming the fix.

Then run it:

```bash
docker compose --profile transcoder up -d
```

---

## 5. Import

**Dashboard:** *Import from transcoder* → pick a machine → browse its mounted
folders → select files → review title, playback policy and output settings →
import. The browser never connects to your machine; the request is collected on
the agent's next poll.

**CLI, from the machine holding the files:**

```bash
openvod-transcoder import /srv/media/course/lesson-01.mp4 \
  --policy signed --subtitle
```

Either way the file is registered (root name + relative path + identity) and the
job is queued. Progress is visible in the dashboard, including which rendition is
encoding and what the encoder is doing.

---

## Hardware

FFmpeg lists what it was *compiled* with, which is not the same as what works.
Every backend below is verified with a real encode of two synthetic frames
before it is offered, and the chosen backend is re-verified against your actual
source before a job commits to it.

| Backend | Encoder | Requirements |
| --- | --- | --- |
| CPU | `libx264` | none beyond the image |
| NVIDIA | `h264_nvenc` | host driver + NVIDIA Container Toolkit |
| AMD | `h264_vaapi` | `/dev/dri/renderD128` + Mesa VAAPI |

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

With `OPENVOD_ENCODER=auto`: verified NVENC → verified VAAPI → CPU. A hardware
path that fails on your specific source first retries with software
decode/filter and the *same* hardware encoder; only if that fails does it reach
the CPU. Every fallback is recorded on the job, so "why was this slow?" has an
answer.

With an explicit backend (`nvenc`, `vaapi`), there is **no** silent fallback: if
the GPU is unusable the job fails with the reason and the remedy. Choosing a GPU
and quietly getting a CPU encode is the outcome an operator least wants.

Fallback never happens for bad media, a missing file, a full disk or a failed
upload — re-running those elsewhere changes nothing.

---

## Operating it

| Situation | Behaviour |
| --- | --- |
| Agent offline before starting | job stays queued, dashboard shows *waiting for agent* |
| Agent restarts | reconciles with the API before resuming; superseded attempts are abandoned |
| Network drops mid-upload | retried with backoff while the lease is valid |
| Lease lost | work stops **before** expiry; nothing uploads or finalizes under lost ownership |
| Partial encode | only the missing rendition is re-encoded |
| Partial upload | only the missing objects are re-sent; nothing is re-encoded |
| Original moved or changed | `SOURCE_MISSING` / `SOURCE_CHANGED`; re-select the file. Retries do **not** consume the attempt budget |
| Job cancelled or video deleted | work stops, late completion is rejected, artifacts are scheduled for cleanup |

Original files are never modified or deleted. The agent copies (or reflinks) the
source before encoding, and removes only its own copy.

**Rollback.** Set `SELF_HOSTED_ENABLED=false`. New local submissions stop;
accepted jobs drain or can be cancelled from the dashboard. Local files are never
moved to Modal automatically.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `encoder backend 'nvenc' ... is not usable` | missing `video` capability, or the host driver is older than the codec |
| `encoder backend 'vaapi' ... is not usable` | render device not passed through, or the user is not in the `video` group |
| Job stuck at *waiting for agent* | no heartbeat within 90 s — check the container is running and `OPENVOD_API_URL` is reachable from it |
| Job stuck at *source-changed* | the file was edited after registration; re-select it |
| `SOURCE_UNREADABLE` | permissions on the mount, or the file is not a regular file |
| Upload fails repeatedly | the transcoded bucket or its credentials are wrong; `doctor` does not cover object storage, by design — the agent holds no storage credentials |
