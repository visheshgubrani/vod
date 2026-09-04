# Delivery ↔ Server ↔ Transcoder contract

The delivery worker, the API, and the transcoder communicate through **three
implicit contracts**. All three live in one repository but deploy separately —
change them together and keep this document in sync.

## 1. Object layout (transcoded bucket)

Every transcoded video lives under a folder keyed by its UUID:

```
videos/<video_id>/playlist.m3u8        # HLS master playlist
videos/<video_id>/stream_<label>.m3u8  # per-rendition playlists
videos/<video_id>/video_<label>_<n>.m4s  # fMP4 segments (+ init .mp4)
videos/<video_id>/manifest.mpd         # DASH manifest
videos/<video_id>/poster.jpg
videos/<video_id>/subtitles.vtt        # when generated
videos/<video_id>/chapters.json        # when generated
```

The delivery worker extracts the video id with `^videos/([^/]+)/`.

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
  "playbackPolicy": "public | signed",
  "generateSubtitle": false,
  "generateChapters": false,
  "organizationId": "<org>",
  "callbackUrl": "https://<api>/api/webhook/transcode-complete"
}
```

Callback (`success`/`error`) is retried by the transcoder; heartbeats POST to
`/api/webhook/heartbeat` with `{ video_id, stage, progress, ts }`. Both are
authenticated with the ingest secret (bearer / `x-webhook-secret`).

## 6. Health probes

- API: `GET /health` (text `ok`), `GET /health/config` (JSON capability flags)
- Delivery: `GET /health` (text `ok`) — added before key resolution
