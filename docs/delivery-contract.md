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
| Modal worker (and every video encoded before self-hosting) | `videos/<id>/…` |
| Self-hosted agent | `videos/<id>/attempts/<attempt-id>/…` |

Self-hosted attempts are **attempt-scoped** because a late worker from a
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

The transcoder (`openvod_transcoder/transfer/s3.py` for Modal,
`transfer/signed.py` for an agent) must set these custom metadata
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
- `iss`: `openvod`, `aud`: `playback`
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

Ingest guards (Modal env): `ALLOWED_SOURCE_BUCKETS` restricts payload
`bucket` values when set; `input_url` sources require `ALLOWED_URL_HOSTS`;
`ALLOWED_CALLBACK_HOSTS` must list your API host for callbacks/heartbeats
(unset = localhost only, loud startup warning).

## 6. Self-hosted agent protocol (`/api/transcoder/v1`)

**Protocol version: 1.** The version is returned by `POST /pair`,
`GET /whoami` and every `claim`, and is bumped only for a breaking change. An
agent that receives a version it does not know must refuse to run rather than
guess: a mismatch here means an encode with the wrong options, or a completion
against the wrong lifecycle.

The agent **initiates every connection**. It has no public listener, needs no
port forwarding, and never connects to the database. That is a product
constraint as much as a security one: an owner who must configure ingress before
their first video encodes will not finish the setup.

### Credentials

| Secret | Lifetime | Storage | Scope |
| --- | --- | --- | --- |
| Pairing code | 15 minutes, single use | SHA-256 digest (`transcoder_pairing`) | one organization |
| Agent token | until revoked | SHA-256 digest (`transcoder_agent.token_hash`) | one organization, one agent |

An agent token can poll its own control requests, claim work for its
organization, report on attempts it owns, and request transfers for paths in its
own inventory. It **cannot** mint playback tokens, administer users, or read
another tenant's data — enforced by the agent routes carrying their own
middleware (`requireAgent`) rather than by a deny-list, which is a list that goes
stale.

### Operations

| Operation | Purpose |
| --- | --- |
| `POST /pair` | redeem a pairing code for a machine credential |
| `POST /rotate`, `POST /revoke`, `GET /whoami` | credential lifecycle |
| `POST /heartbeat` | capabilities, progress, lease renewal |
| `GET /poll` | pending control requests + remaining capacity |
| `POST /claim` | take the oldest eligible job (or one named job) |
| `POST /reconcile` | after a restart: which attempts may be resumed |
| `POST /jobs/:id/inventory` | declare the artifacts this attempt will upload |
| `POST /inventories/:id/grants` | presigned PUT URLs, bounded and renewable |
| `POST /inventories/:id/uploaded` | the agent's claim that paths are in place |
| `POST /inventories/:id/verify` | API confirms objects exist at the recorded size |
| `POST /jobs/:id/complete` | publish, gated on verification and ownership |
| `POST /jobs/:id/fail` | terminal or retryable failure |
| `POST /jobs/:id/resume` | re-acquire an attempt this agent already owns, after a restart |
| `POST /sources/:id/grant` | short-lived download URL for an r2 source |
| `POST /sources` | register a local file (root name + relative path only) |
| `GET /jobs`, `POST /jobs/:id/cancel`, `POST /jobs/:id/retry` | operator commands |

### Local source semantics

A `local` source is **bound to exactly one agent**: the machine holding the file.
No other agent is eligible, and waiting never changes that. The queue reports the
condition rather than moving the job:

| `waiting_reason` | meaning |
| --- | --- |
| `agent-offline` | the bound agent has not been seen within the liveness window |
| `agent-busy` | the agent is at its configured job capacity |
| `source-missing` | the file is gone or the folder is not mounted |
| `source-changed` | the file's identity differs from what was registered |
| `no-eligible-agent` | the source has no bound agent (unrecoverable without re-selection) |
| `retry-backoff` | between attempts after a retryable failure |
| `capacity` | the organization is at its concurrency cap |

Absolute host paths are **never** sent to the API and never returned by it. A
browse result and a source registration carry a configured root name plus a
root-relative path; the API refuses an absolute path rather than normalising it.

### Attempt prefixes and publication verification

1. The agent registers an inventory of `{path, size, checksum, role}`. Paths are
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
   compromised agent cannot point a viewer at another origin.

This is atomic publication of the **application's playback reference**, not an
atomic multi-object object-store upload — the latter is not a thing that exists.

### Completion, replay and recovery

Completion is **idempotent**. The API records a receipt on the job when it
publishes, and a replay — which arrives precisely when the agent did not see the
response — is answered with that receipt rather than a 404. A replay that names a
different attempt is refused with the recorded receipt attached.

Publication and the job's own terminal write happen in **one transaction**, with
an agreement assertion. A guarded `UPDATE` that matches nothing is not an error,
so without the assertion a transaction whose second statement silently no-opped
would still commit — leaving a `ready` video beside a `publishing` job that no
replay could repair.

Restart recovery has three parts, and all three are needed:

1. `POST /reconcile` reports which attempts the agent still owns;
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

- **Additive migrations only.** The agent tables are new; no existing column
  changed meaning. `video.transcode_attempt_id`, the lease, the state machine and
  the webhook outbox keep their current behaviour unchanged.
- **Both database drivers.** Every new statement is a single guarded CTE, so it
  behaves identically on `neon-http` (batch) and `postgres-js` (transaction).
- **Modal is unaffected.** A Modal callback passes no `outputPrefix` and no
  inventory gate; `videos/<id>/…` URLs and legacy player URL construction keep
  working exactly as before.
- **Rollback.** Set `SELF_HOSTED_ENABLED=false` to stop accepting new local
  submissions. Accepted jobs drain or can be cancelled explicitly. Local files
  are never moved to Modal automatically.

### Error codes added for self-hosted jobs

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

`POST /api/upload/complete`, `POST /api/upload/multipart/complete` and
`POST /v1/upload/complete` accept an optional `transcodingProvider` of `"modal"`
or `"self-hosted"`. Omission uses the installation default (`TRANSCODE_PROVIDER`).

Resolution rules, all enforced in `server/src/utils/dispatchProvider.ts` so the
three call sites cannot disagree:

- An unrecognised value is **refused**, never silently replaced by the default. A
  caller that asked for a specific engine is told it cannot have it.
- The choice is written to `transcode_job.provider` at creation. Changing the
  installation default never reroutes an existing job.
- A self-hosted submission is refused with `503` (`provider-disabled`) when
  `SELF_HOSTED_ENABLED=false`. It does **not** fall back to Modal: an owner who
  turned local encoding off did not ask for their files to be uploaded to someone
  else's cloud.
- An uploaded object becomes an `r2` source with **no bound agent**, so any
  eligible machine in the organization may claim it. A `local` source is pinned
  to the one machine holding the file; the two are deliberately different.

The raw bucket is still required for browser/SDK uploads whichever provider
reads them — the bytes need somewhere to wait. It is not required when the only
source is files on the owner's machine.

## 8. Capability reporting

Two projections, deliberately different:

**Public** (`GET /health/config` → `transcode`) — booleans and counts only:
uploads available, local import available, configured providers, the default
provider, enrichment availability, and `{paired, online}` agent counts. Never
names, hostnames, paths or credentials.

**Authenticated** (`GET /api/transcoder/health`) — per-agent connectivity,
capacity, encoder list and scratch headroom, plus the queue's state histogram.

## 9. Health probes

- API: `GET /health` (text `ok`), `GET /health/config` (JSON capability flags)
- Delivery: `GET /health` (text `ok`) — added before key resolution
- Agent: `openvod-transcoder doctor` (exit code is the answer)
