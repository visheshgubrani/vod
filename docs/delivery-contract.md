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

The delivery worker extracts the video id with `^videos/([^/]+)/`, so anything
that lists or deletes a video's output must use the `videos/<id>/` prefix — a
bare `<id>/` matches nothing.

## 2. Object metadata (S3 custom metadata)

The transcoder (`transcoding/utils/storage.py`) must set these custom metadata
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

## 6. Health probes

- API: `GET /health` (text `ok`), `GET /health/config` (JSON capability flags)
- Delivery: `GET /health` (text `ok`) — added before key resolution
