# Delivery ↔ Server ↔ Transcoder contract

The delivery worker, the API, and the transcoder communicate through **three
implicit contracts**. All three live in one repository but deploy separately —
change them together and keep this document in sync.

## 1. Object layout (transcoded bucket)

Every transcoded video lives under a folder keyed by its UUID:

```
videos/<video_id>/playlist.m3u8           # HLS master playlist
videos/<video_id>/manifest.mpd            # DASH manifest
videos/<video_id>/video_<label>/init.mp4  # per-rendition fMP4 init segment
videos/<video_id>/video_<label>/<n>.m4s   # per-rendition media segments
videos/<video_id>/audio/init.mp4          # audio rendition, when packaged
videos/<video_id>/audio/<n>.m4s
videos/<video_id>/poster.jpg
videos/<video_id>/subtitles.vtt           # when generated
videos/<video_id>/chapters.json           # when generated
```

`<label>` is the rendition label from the encoding ladder (`360p` … `2160p`),
and segment names are Shaka's zero-based `$Number$` output.

Two layouts are live, and both must keep working:

| Writer | Layout |
| --- | --- |
| Modal worker (and every video encoded before local workers were available) | `videos/<id>/…` |
| Local worker | `videos/<id>/attempts/<attempt-id>/…` |

Local worker attempts are **attempt-scoped** because a late worker from a
superseded attempt would otherwise overwrite the newer attempt's segments after
it published — the application's playback reference would then point at a mix of
two encodes. The attempt id is minted at claim time and is the same value the
video row carries in `transcode_attempt_id`.

The delivery worker extracts the video id with `^videos/([^/]+)/`, which already
accommodates the nested prefix: the first path segment after `videos/` is the
video id in both layouts. Anything that lists or deletes a video's output must
use the `videos/<id>/` prefix — a bare `<id>/` matches nothing, and a cleanup
that forgets `attempts/` reclaims nothing.

Playback URLs are constructed from the prefix the attempt *actually uploaded to*,
recorded in `artifact_inventory.prefix`, never re-derived. `hls_url` therefore
differs in shape between the two layouts, which is why consumers must use the
URL the API returns rather than building one from the video id.

## 2. Object metadata (S3 custom metadata)

The transcoder (`clipmux_transcoder/transfer/s3.py` for Modal,
`transfer/signed.py` for the local worker) must set these custom metadata
on **every object it uploads**:

| Key | Value | Meaning |
| --- | --- | --- |
| `playback-policy` | `public` \| `signed` | Access policy for this object |
| `organization-id` | org UUID | Tenant owner (bandwidth accounting) |

The delivery worker reads `playback-policy` per object; objects missing the
key fall back to `DEFAULT_POLICY` (worker env, default `public`). If you set
`DEFAULT_POLICY=signed`, missing metadata fails closed.

## 3. Playback JWT

Minted by the API (`video.ts` / `api.ts`), verified by the delivery worker:

- HS256, symmetric `JWT_SECRET` **shared between API and delivery worker**
- `iss`: `clipmux`, `aud`: `playback`
- Claims: `video_id` (or `sub`), `org_id`, `ua_hash` (SHA-256 of the
  normalized UA family), optional `allowed_domains` (`["*"]` default) and
  `allow_no_referrer` (default `true`)
- Token travels as `?token=`; the worker rewrites it into every sub-resource
  URI of signed playlists (see #4).

## 4. Manifest rewriting rules (signed content)

The worker rewrites `URI="..."` attributes and standalone URI lines for:

- `#EXT-X-KEY`, `#EXT-X-MAP`, `#EXT-X-MEDIA`
- `#EXT-X-I-FRAME-STREAM-INF`, `#EXT-X-SESSION-KEY`,
  `#EXT-X-IMAGE-STREAM-INF`, `#EXT-X-PRELOAD-HINT`,
  `#EXT-X-RENDITION-REPORT`
- standalone `.m3u8` / `.mp4` / `.m4s` / `.ts` lines (CRLF preserved)
- DASH `media="..."`, `initialization="..."`, `<BaseURL>`

**Never** append tokens to foreign-host URIs (data:/blob: URIs are skipped).
Playlists must use relative URIs (Shaka packager output does).

## 5. Transcode job payload (API → Modal)

```jsonc
{
  "key": "orgs/<org>/raw/<video_id>/<file>.mp4", // raw bucket key
  "bucket": "<raw bucket>",
  "fileId": "<video_id>",
  "attemptId": "<uuid>",                          // required — see below
  "playbackPolicy": "public | signed",
  "generateSubtitle": false,
  "generateChapters": false,
  "organizationId": "<org>",
  "callbackUrl": "https://<api>/api/webhook/transcode-complete",
  "heartbeatUrl": "https://<api>/api/webhook/heartbeat" // derived
}
```

### Attempt ownership (required)

`attemptId` identifies which attempt owns the video row. It is not advisory:

- The API claims the row with this id before dispatching. A claim that loses —
  because another attempt is live, the video is deleted, or the organization is
  at its concurrency cap — means **no dispatch happens at all**.
- The transcoder must **suppress a repeat delivery of an attempt id it has
  already accepted**. The API's dispatcher retries a POST whose response was
  lost; without suppression that retry spawns a second GPU container for the
  same video and the tenant pays twice. Suppression lives in a Modal `Dict`
  written *before* the worker spawns.
- A retry of an **uncertain** dispatch must reuse the **same** `attemptId`.
  Minting a new one is indistinguishable from starting a second job.
- Every callback and heartbeat must echo `attempt_id`. The API rejects a
  callback or beat whose attempt id does not match the row's current owner, and
  uses accepted beats to extend that attempt's lease.

### Upgrade order

These components deploy separately, so this change is **ordered**:

1. **Deploy the transcoder first.** A new transcoder against an old API is
   harmless: the old API ignores the extra `attempt_id` field.
2. **Then deploy the API.**

Deploying the API first would reject heartbeats from the old transcoder (a row
dispatched by the new code has an owner, so an unidentified beat is refused).
The lease would then expire mid-encode, the sweeper would reclaim the job, and
the same video would encode twice — the exact failure attempt ownership exists
to prevent.

### Callback and heartbeat payloads

Callbacks are retried by the transcoder (4xx never retried, backoff + jitter).
Heartbeats POST to `/api/webhook/heartbeat` with
`{ video_id, stage, progress, ts, attempt_id }`. Both are authenticated with
the ingest secret (bearer / `x-webhook-secret`). Heartbeats are strictly
non-fatal on the worker side: the pipeline never aborts because a beat failed.

A beat exists to extend the attempt's lease (20 minutes), and the two sides
**coalesce** their beats so that renewing a 20-minute lease does not cost a
database write per encoder-second:

| Side | Cadence |
| --- | --- |
| worker progress beats | at most one per `PROGRESS_BEAT_SECONDS` (15s), plus one immediately on every stage change |
| worker liveness thread | every 30s, unconditional; carries the latest stage/progress |
| local worker progress beats | at most one per `progress_beat_seconds` (`CLIPMUX_PROGRESS_BEAT_SECONDS`, 15s), plus every stage change; the per-job lease probe is independent |
| API write guard | a beat whose row was already beaten inside `HEARTBEAT_WRITE_MIN_INTERVAL_MS` (10s) answers `{ success: true, throttled: true }` without writing |

Coalescing is a load guard, never an ownership guard: attempt and status checks
run first on both sides, so a superseded attempt is still refused (`ignored`)
and never kept alive by a throttled beat. Any 2xx — `success`, `ignored` or
`throttled` — means the same thing to the worker: the beat landed, keep going.

The two windows are independent, so a stage change that arrives at the API a
moment after a progress beat is acknowledged but not recorded. That costs at most
one progress interval of staleness in the stored stage — the worker re-sends the
stage on its next beat — and the worker must **not** wait for the API before
moving on. A `throttled` answer means "I already have a fresher beat", not "send
this again immediately".

Error callbacks carry a stable `error_code` (server stores it in
`video.failure_code`):

| code | meaning |
| --- | --- |
| `INVALID_CONTAINER` | ffprobe found no audio/video stream |
| `EMPTY_FILE` | zero-byte/truncated file, or no duration |
| `INVALID_METADATA` | video stream present but unusable dimensions |
| `INSUFFICIENT_DISK` | /tmp cannot hold this source |
| `PARTIAL_UPLOAD` | some transcoded files failed to reach R2 |
| `AUDIO_ONLY_UNSUPPORTED` | reserved legacy code (audio-only now packaged) |
| `TRANSCODE_FAILED` | any other pipeline failure |

Success callbacks carry `processing` alongside `outputs`/`metadata`/`inventory`.
Three fields in it are **diagnostics**, added additively: an older API that
ignores them still publishes correctly, an older engine that omits them still
parses, and no existing key changed meaning:

| field | shape | meaning |
| --- | --- | --- |
| `backend` | `cpu` \| `nvenc` \| `vaapi` \| `mixed` | which encoder produced the job. `mixed` means the ladder finished across more than one encoder — each rendition carries its own fallback state — so the per-rung answer is in `renditions`. |
| `renditions[]` | `{label, width, height, bitrate, backend, mode, attempts, seconds, bytes}` | what actually produced each rung. `mode` is `cpu` \| `gpu` \| `hybrid` \| `reused`; `attempts` counts encoder attempts for that rung (a session-exhaustion retry is the second). |
| `toolchain` | `{engine, planVersion, ffmpeg, shaka}` | version identity of the toolchain that produced the bytes. It is also part of the reuse fingerprint, so an image upgrade invalidates reusable intermediates instead of mixing two encoders' output. |

`PACKAGING_FAILED` keeps its meaning and its job-level retryability, but it no
longer re-enters the *engine's* encoder chain: Shaka runs after every rendition
is encoded, so there is no encoder left to fall back from.

Ingest guards (Modal env): `ALLOWED_SOURCE_BUCKETS` restricts payload
`bucket` values when set; `input_url` sources require `ALLOWED_URL_HOSTS`;
`ALLOWED_CALLBACK_HOSTS` must list your API host for callbacks/heartbeats
(unset = localhost only, loud startup warning).

## 6. Local worker protocol (`/api/transcoder/v1`)

Protocol version: 1. The worker initiates every connection, has no public
listener, and never connects directly to Postgres. One stable deployment worker
identity (`local`) claims the oldest eligible local job across organizations.
The setup-managed Compose service holds an exclusive lock on its persistent
journal volume, so a second daemon fails clearly instead of duplicating work.

### Credential and tenant scope

The API and worker share `LOCAL_TRANSCODER_SECRET`, generated and reused by the
setup wizard. Worker endpoints accept it only in the
`x-local-transcoder-secret` header through `requireLocalWorker`; it cannot
authenticate a dashboard, upload, playback, or organization-management request.
The secret carries no organization membership. A claimed job and its source and
inventory relationships supply tenant identity, and each transfer requires the
current attempt, live lease, and matching video owner.

Host-folder import is separately restricted by `LOCAL_IMPORT_ORG_ID`. Only
owners/admins of that existing organization can browse roots or submit imports;
worker control requests and CLI source registration are limited to it. Leaving
the setting unset disables folder import without affecting uploaded jobs.
Dashboard queues and API-key imports remain organization-scoped.

### Operations

| Operation | Purpose |
| --- | --- |
| `GET /config` | read-only credential/configuration check for `doctor`; never writes liveness |
| `GET /drain-status` | authenticated outstanding-local-job count for managed provider switching |
| `POST /heartbeat` | worker capabilities, capacity, progress and lease renewal |
| `GET /poll` | configured-organization control requests and worker capacity |
| `POST /control/:id` | answer an authorized browse/register request |
| `POST /claim` | claim the oldest eligible local job across organizations |
| `POST /reconcile` | after restart, identify attempts the worker still owns |
| `POST /jobs/:id/inventory` | declare artifacts this attempt will upload |
| `POST /inventories/:id/grants` | bounded, renewable presigned PUT URLs |
| `POST /inventories/:id/uploaded` | report uploaded paths |
| `POST /inventories/:id/verify` | API confirms objects exist at the recorded size |
| `POST /jobs/:id/complete` | publish, gated on verification and ownership |
| `POST /jobs/:id/fail` | report a terminal or retryable failure |
| `POST /jobs/:id/resume` | re-acquire an attempt this worker still owns after restart |
| `POST /sources/:id/grant` | short-lived source URL, only for a live owned attempt |
| `POST /sources` | register a root-relative file for the configured import organization |

Queue inspection, retry and cancellation use the authenticated dashboard/API,
not worker CLI commands.

### Local source semantics

Local files are rooted in this installation's explicitly mounted directories;
there is no worker affinity. Uploaded R2 sources and local sources can be claimed
by the same worker. Claims enforce total worker capacity and each organization's
concurrency cap, skipping a capped organization so it cannot block other tenants.

| `waiting_reason` | meaning |
| --- | --- |
| `worker-offline` | no worker heartbeat in the liveness window |
| `worker-busy` | the worker is at its configured job capacity |
| `source-missing` | a mounted file is gone or its folder is unavailable |
| `source-changed` | the file identity differs from registration |
| `capacity` | this organization is at its concurrency cap |
| `retry-backoff` | waiting between attempts after a retryable failure |

Absolute host paths are never sent to the API or returned. Browse and source
registration carry a configured root name plus a root-relative path; the API
refuses an absolute path rather than normalizing it.

### Attempt prefixes and publication verification

1. The worker registers an inventory of `{path, size, checksum, role}`. Paths are
   prefix-relative; `..`, absolute paths, backslashes and NUL bytes are refused.
2. Grants are issued per path, bounded to the attempt prefix, and only for paths
   on the inventory. Renewal is refused once the attempt is superseded.
3. Uploads are ordered segments-first, playlists-last (the ordering is applied in
   SQL, because the grant call is paged).
4. The API HEADs every object and compares the **size**. Multipart ETags are
   never used as content hashes — the same bytes uploaded in different part sizes
   produce different ETags.

   Both grants and verification are **paged** (250 per call, loop until
   `remaining` is 0). A two-hour 1080p ladder is roughly 9,000 objects: a
   single-page implementation uploads the first 250 and fails the rest, and one
   unbounded verification call would exceed a Worker's subrequest and CPU
   budgets and time out with the inventory neither verified nor failed.
5. Completion is refused unless every inventory item is verified **and** the
   attempt still owns the video row. Both guards are in the same statement as the
   transition, so "verified" and "ready" cannot be separated by a crash.
6. A grant is issued only while the attempt is *live*: the job must still name
   the inventory's attempt, be in an active state, hold an unexpired lease, and
   its video must be undeleted and still name that attempt. A grant or upload
   confirmation whose lease cannot be renewed is refused rather than issued.
   Retry, cancel and lease reclaim retire the old inventory (`superseded`).
7. `artifact_inventory.prefix` becomes the published prefix. `hls_url`,
   `thumbnail_url` and `subtitle_url` are built from it against `DELIVERY_URL`;
   an absolute URL in a completion payload is reduced to its pathname, so a
   compromised worker cannot point a viewer at another origin.

This is atomic publication of the **application's playback reference**, not an
atomic multi-object object-store upload — the latter is not a thing that exists.

### Completion, replay and recovery

Completion is **idempotent**. The API records a receipt on the job when it
publishes, and a replay — which arrives precisely when the worker did not see the
response — is answered with that receipt rather than a 404. A replay that names a
different attempt is refused with the recorded receipt attached.

Publication and the job's own terminal write happen in **one transaction**, with
an agreement assertion. A guarded `UPDATE` that matches nothing is not an error,
so without the assertion a transaction whose second statement silently no-opped
would still commit — leaving a `ready` video beside a `publishing` job that no
replay could repair.

Restart recovery has three parts, and all three are needed:

1. `POST /reconcile` reports which attempts the worker still owns;
2. `POST /jobs/:id/resume` re-acquires them, extending both leases;
3. the engine's reuse path skips already-encoded renditions, keyed on the
   **source hash and plan fingerprint** — not on the attempt id, which changes on
   every retry. Encoded renditions are checkpointed to a per-video cache the
   moment they finish, before packaging and long before upload, because a job
   that fails during transfer must resume without re-encoding.

### Failure classification

| class | codes | behaviour |
| --- | --- | --- |
| source condition | `SOURCE_MISSING`, `SOURCE_CHANGED`, `SOURCE_UNREADABLE` | back to `queued` with an explicit `waiting_reason`, **always**; the claim's attempt increment is undone so waiting never spends the execution budget |
| retryable | `ENCODER_*`, `PACKAGING_FAILED`, `STALLED`, `PARTIAL_UPLOAD`, … | back to `queued` until the budget is spent, then terminal |
| terminal | `INVALID_CONTAINER`, `EMPTY_FILE`, `INVALID_METADATA`, `UNSUPPORTED_HDR`, `MISSING_RENDITION` | failed immediately; re-running the same bytes changes nothing |

### Compatibility requirements

- **Forward migration.** The singleton worker/control tables replace fleet and
  pairing tables; affinity columns and indexes are removed. Execution state,
  attempt ownership, the state machine and webhook outbox retain their behavior.
- **Guarded CTEs.** Every new statement is a single guarded CTE, so
  publication and job admission keep their concurrency guarantees inside a
  postgres-js transaction.
- **Modal is unaffected.** A Modal callback passes no `outputPrefix` and no
  inventory gate; `videos/<id>/…` URLs and legacy player URL construction keep
  working exactly as before.
- **Provider switch.** `LOCAL_TRANSCODE_ENABLED=false` stops new local
  submissions while accepted jobs remain drainable. Managed local-to-Modal setup
  verifies that the local queue is empty before stopping the worker. Local files
  are never moved to Modal automatically.

### Error codes added for local jobs

| code | meaning | retryable |
| --- | --- | --- |
| `SOURCE_MISSING` | the file moved, was deleted, or the folder is unmounted | yes, without consuming the attempt budget |
| `SOURCE_CHANGED` | the file changed since registration | yes, without consuming the attempt budget |
| `SOURCE_UNREADABLE` | permissions, or not a regular file | yes |
| `ENCODER_UNAVAILABLE` | the selected backend is not usable on this machine | yes, falls back in `auto` mode |
| `ENCODER_FAILED` | the backend started but the encode failed | yes, falls back in `auto` mode |
| `UNSUPPORTED_HDR` | an HDR variant with no validated SDR conversion | no |
| `PACKAGING_FAILED` | Shaka failed or produced an incomplete package | yes |
| `MISSING_RENDITION` | a required rendition is absent from the package | no |
| `STALLED` | no encoder progress within the stall window | yes |
| `CANCELLED` | operator cancel — mapped to `cancelled`, never `video.failed` | no |

## 7. Provider selection on uploads

Provider selection is deployment-wide: `TRANSCODE_PROVIDER=modal|local` applies
to new jobs, and the chosen value is recorded in `transcode_job.provider`.
Changing the setting never reroutes accepted work. Upload requests containing
the removed `transcodingProvider` field are rejected with a validation error
before storage completion or job dispatch.

`LOCAL_TRANSCODE_ENABLED=false` rejects new local submissions. It does not
silently send local work to Modal; accepted local jobs remain drainable. Uploaded
objects become tenant-owned `r2` sources and can be claimed by the deployment's
single worker. Host-folder imports remain optional and require
`LOCAL_IMPORT_ORG_ID`.

The raw bucket is still required for browser/SDK uploads whichever provider
reads the bytes. It is not required when uploads are disabled and all sources
are already mounted on the host.

## 8. Capability reporting

**Public** (`GET /health/config` → `transcode`) reports secret-free provider
configuration and coarse availability, including whether the local worker is
online. It does not expose hostnames, paths, credentials or another tenant's
jobs.

**Authenticated** dashboard status shows one shared local-worker record and the
active organization's queue and progress. It does not expose other organizations'
job rows or source references.

## 9. Health probes

- API: `GET /health` (text `ok`), `GET /health/config` (JSON capability flags)
- Delivery: `GET /health` (text `ok`) — added before key resolution
- Worker: `clipmux-transcoder doctor` (exit code is the answer)
