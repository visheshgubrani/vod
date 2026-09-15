# ClipMux · Next.js integration example

A runnable, minimal Next.js 16 (app router, React 19, strict TypeScript) app that
demonstrates the **whole documented ClipMux developer experience** end to end:

```
browser                     your Next.js app                 ClipMux API
───────                     ────────────────                 ───────────
choose a file ────────────▶ POST /api/upload-token
                            └─ new ClipMux({ apiKey }) ─────▶ POST /v1/upload/token
                                                                 (API key, server-side only)
ClipMuxUploader.upload() ─────────────────────────────────▶ POST /v1/upload/create
  onProgress → progress bar                                POST /v1/upload/parts (windowed)
                                                           PUT  <presigned R2 URL>
                                                           POST /v1/upload/complete
poll /api/video-status/[id] ▶ GET /v1/video/:id ──────────▶  … status: processing
   every 5s                     POST /v1/video/:id/playback-token
                                   (viewer UA forwarded)
ClipMuxPlayer src+token ◀─── { playbackUrl, token, subtitles, chapters }
  token refresh ──────────▶ POST /api/play-token/[id] ────▶ POST /v1/video/:id/playback-token
webhooks ◀───────────────────────────────────────────────  POST /api/webhooks/clipmux
                                                             video.ready / video.failed
```

So a single page shows the four things an integration actually needs: **upload**,
**playback**, **token refresh** and **webhooks**.

## Files

| Path | What it shows |
|---|---|
| `app/page.tsx` | The demo. File input → `POST /api/upload-token` → `new ClipMuxUploader({ baseUrl, uploadToken }).upload(file, { onProgress })` → progress bar → poll while `processing` → `<ClipMuxPlayer>`. Errors are matched on `ClipMuxError.code`; the Cancel button aborts through an `AbortSignal` (`UploadAbortedError`). |
| `app/api/upload-token/route.ts` | `vod.uploads.createToken({ expiresIn: '1h', maxFiles: 1 })` → `{ uploadToken, expiresAt }`. The canonical "your API key never reaches the browser" sample. |
| `app/api/video-status/[id]/route.ts` | `vod.videos.get(id)`, then `vod.playback.createToken(id, { viewerUserAgent })` once it is `ready` → `{ status, playbackUrl, token, subtitleUrl, chapters }`. |
| `app/api/play-token/[id]/route.ts` | What the player's `tokenRefreshEndpoint` calls; returns `{ token }`. |
| `app/api/webhooks/clipmux/route.ts` | `await req.text()` (raw body!) → `constructWebhookEvent(...)` → switch on `event.event`. |
| `lib/clipmux.ts` | The shared, memoized `ClipMux` client. |
| `scripts/e2e-upload.mjs` | Manual Node script: the same flow without a browser. |

Public entry points used: `@clipmux/uploader` (`ClipMuxUploader`, `ClipMuxError`,
`isUploadAbortedError`), `@clipmux/player` (`ClipMuxPlayer`), `@clipmux/server`
(`ClipMux`, `constructWebhookEvent`, `WebhookSignatureError`). All three are
workspace packages, resolved through `"workspace:*"`.

## Run it

```bash
# 1. From the repo root: install, then build the packages this example consumes
#    (it resolves their dist/, exactly like a published install).
pnpm install
pnpm --filter ./sdk build && pnpm --filter ./player build && pnpm --filter ./server-sdk build

# 2. Configure the example.
cd examples/nextjs-integration
cp .env.example .env.local     # then set CLIPMUX_API_KEY (+ the webhook secret)

# 3. Start the API (a second terminal, repo root) and this app.
pnpm dev                       # API on http://localhost:8787
pnpm --filter ./examples/nextjs-integration dev     # app on http://localhost:3000
```

`pnpm dev:example` from the repo root is shorthand for the last command.

Open <http://localhost:3000>, choose a video, press **Upload**, and watch it go
from `initializing` → `uploading` → `completing` → `processing` → `ready`, at
which point the player replaces the progress bar.

`CLIPMUX_API_URL` and `NEXT_PUBLIC_CLIPMUX_API_URL` must point at the same
deployment: the server mints the upload token, the browser then uses it against
`NEXT_PUBLIC_CLIPMUX_API_URL`.

### Build without a backend

```bash
pnpm --filter ./examples/nextjs-integration build
```

`next build` needs **no** API and no `.env.local`: every route that talks to
ClipMux is `dynamic = 'force-dynamic'` and reads its config at request time.

## The manual e2e script

`scripts/e2e-upload.mjs` performs the same flow from Node — useful when you need
to tell "the browser is broken" apart from "the API/storage is broken". It is a
manual tool, not a test: it needs a **running local stack** and it really writes
to your storage and spends a transcode job.

```bash
CLIPMUX_API_KEY=sk_live_… \
CLIPMUX_API_URL=http://localhost:8787 \
node examples/nextjs-integration/scripts/e2e-upload.mjs ./clip.mp4
```

It mints an upload token with `@clipmux/server`, uploads with
`@clipmux/uploader` (from `sdk/dist`, the same build the app uses), then polls
`vod.videos.get()` until the video is `ready` and prints the playback URL.

Flags: `--title <t>`, `--signed`, `--subtitles`, `--no-wait`, and
`--watch <videoId>` to poll an existing video instead of uploading.

For a `--signed` video the script mints the playback token with a fixed
`clipmux-e2e-script/1.0` User-Agent: signed tokens are bound to the viewer's UA
and there is no browser here, so the URL it prints only plays for a client that
sends that same UA. The app instead forwards the real viewer's UA.

> Node has no `File`, so the script passes a `Blob` plus an explicit `filename` —
> that is the documented way to use the uploader outside a browser.

## Required storage CORS

The browser uploads parts **directly to R2**, so the raw bucket must allow `PUT`
from your app's origin **and expose `ETag`**:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000",
      "http://127.0.0.1:3000"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ExposeHeaders: ["ETag"]` is not optional. Without it the browser cannot read the
part ETags, so `POST /v1/upload/complete` fails even though every part uploaded
successfully. Add your production origin to `AllowedOrigins` when you deploy.

## Webhooks

Point your deployment's webhook URL at
`https://your-app.example.com/api/webhooks/clipmux` and set
`CLIPMUX_WEBHOOK_SECRET` to the signing secret. The route:

1. reads the **raw** body (`await req.text()`). The signature is
   `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`; re-serializing parsed JSON
   changes the bytes and the digest never matches.
2. calls `constructWebhookEvent({ secret, rawBody, signature, timestamp, event })`,
   which **verifies before it parses**. A `WebhookSignatureError` answers `400`
   with its `reason` (`missing_header`, `malformed`, `invalid_timestamp`,
   `stale`, `mismatch`).
3. switches on `event.event` for `video.ready` / `video.failed`.

`video.ready` and `video.failed` are delivered through a transactional outbox
and retried until they succeed, so they are **at-least-once**: de-duplicate on
`event.id`, which is stable across retries. The example uses an in-process `Set`
and says so — a real app needs durable storage.

For local testing, expose `:3000` with a tunnel and register the tunnel URL, or
POST a signed body yourself while developing.

## Notes and gotchas

- **Forward the viewer's User-Agent.** Signed playback tokens are bound to it and
  the delivery worker enforces the binding, so `viewerUserAgent:
  request.headers.get('user-agent')` is required — a token minted with the
  server's UA is rejected in the browser.
- **`tokenRefreshEndpoint` as a string is fetched with `credentials: 'include'`.**
  That is why a same-origin route such as `/api/play-token/[id]` works: your
  session cookie is sent. For a cross-origin API, pass the player's **callback**
  form instead (`tokenRefreshEndpoint={async () => …}`) rather than relying on
  cross-origin cookies.
- **Authorize the refresh route.** `POST /api/play-token/[id]` is where a viewer
  proves they may watch *this* video. The example leaves a marked TODO: replace
  it with your own session/ownership check before shipping.
- **Analytics are opt-in** and off unless `analyticsEndpoint` is set. The journal
  route currently accepts unauthenticated events, so keep it behind your own
  proxy if the numbers matter.
- **Tokens are short-lived by design.** The page mints a fresh playback token on
  every status poll; the player refreshes it before expiry without interrupting
  playback.

## License

Apache-2.0
