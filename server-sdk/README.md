# @openvod/server

The server-side SDK for a self-hosted [OpenVOD](https://github.com/visheshgubrani/vod)
deployment: mint **upload tokens** for browsers, mint **playback tokens** for
viewers, manage videos, and **verify webhooks**.

Your API key (`sk_live_…`) only ever lives here — in your backend, never in a
browser.

```bash
npm install @openvod/server
```

```ts
import { OpenVod, constructWebhookEvent } from '@openvod/server'

const vod = new OpenVod({
  apiKey: process.env.OPENVOD_API_KEY!,
  baseUrl: process.env.OPENVOD_API_URL!, // https://api.yourvod.com — no /v1 suffix
})
```

## The three calls every integration needs

### 1. Upload token — for the browser

```ts
// app/api/upload-token/route.ts
export async function POST() {
  const token = await vod.uploads.createToken({ expiresIn: '1h', maxFiles: 1 })
  return Response.json({ uploadToken: token.upload_token, expiresAt: token.expires_at })
}
```

The token is scoped to your organization, expires (24h max), and can cap the
number and size of files. It is only checked when an upload *starts*, so a slow
upload is never cut off by its own token lapsing.

Then in the browser, [`@openvod/uploader`](https://www.npmjs.com/package/@openvod/uploader)
takes it from there.

### 2. Playback token — for one viewer

```ts
const session = await vod.playback.createToken(videoId, {
  expiresIn: '2h',
  // Required for signed videos: the token is bound to the viewer's UA and the
  // delivery worker enforces the binding.
  viewerUserAgent: req.headers.get('user-agent') ?? undefined,
  allowedDomains: ['app.example.com', '*.example.com'],
})

session.playback_url // already carries ?token= for signed videos
session.token        // null for public videos
session.subtitle_url // AI-generated VTT, if any
session.chapters     // AI-generated chapters, if any
```

Pass `allowedDomains` to restrict which origins may play the video, and
`allowNoReferrer: false` to require a Referer. Both default to permissive
(`['*']`, `true`), so set them if the video is meant for one site.

### 3. Webhooks — know when a video is ready

```ts
// app/api/webhooks/openvod/route.ts
export async function POST(req: Request) {
  const rawBody = await req.text() // NOT req.json()

  const event = await constructWebhookEvent({
    secret: process.env.OPENVOD_WEBHOOK_SECRET!,
    rawBody,
    signature: req.headers.get('x-webhook-signature'),
    timestamp: req.headers.get('x-webhook-timestamp'),
    event: req.headers.get('x-webhook-event'),
  })

  if (event.event === 'video.ready') {
    await db.videos.markReady(event.data.videoId, event.data.hlsUrl)
  }

  return Response.json({ received: true })
}
```

`constructWebhookEvent` verifies before it parses, so a forged body never
reaches your JSON. It throws `WebhookSignatureError` with a `reason`:

| `reason` | Meaning |
|---|---|
| `missing_header` | No signature or timestamp header |
| `malformed` | Signature is not 64 hex chars (optionally `sha256=`-prefixed) |
| `invalid_timestamp` | Timestamp is not an integer number of seconds |
| `stale` | Outside the replay window (default ±300s) |
| `mismatch` | Digest does not match — or `X-Webhook-Event` disagrees with the payload |

**Verify the raw body.** The signature is
`HMAC-SHA256(secret, "<timestamp>.<rawBody>")`. Re-serializing parsed JSON
(`JSON.stringify(req.body)`) usually produces different bytes — key order,
spacing, number formatting — and never matches. This is the single most common
integration bug.

Already have the raw body verified elsewhere? `parseWebhookEvent(rawBody)`
parses without checking, and is named to be conspicuous at the call site.
`checkWebhookSignature()` is the non-throwing form of the verifier.

#### Delivery guarantees

| Events | Delivery |
|---|---|
| `video.ready`, `video.failed` | Transactional outbox — retried until delivered, so treat as **at-least-once** and de-duplicate on `event.id` |
| Every other event | Dispatched once, no retries |

`RELIABLE_WEBHOOK_EVENTS` exports that list; `WEBHOOK_EVENTS` is the full
catalogue.

## Videos

```ts
const video = await vod.videos.get(videoId)          // status: 'ready' | 'processing' | …
const { data } = await vod.videos.list({ status: 'ready', limit: 10 })
await vod.videos.update(videoId, { title: 'New title', playbackPolicy: 'signed' })
await vod.videos.delete(videoId)                     // soft-delete + reclaim scheduled
```

`videos.list()` clamps `limit` to the API's 1–100 range, and `videos.update()`
rejects an empty patch locally instead of spending a round trip on a 400.

## Errors

Every API failure is an `OpenVodError` with a stable `code`:

| `code` | `status` | Retry? |
|---|---|---|
| `UNAUTHORIZED` | 401 | No — check the API key |
| `FORBIDDEN` | 403 | No — wrong organization |
| `NOT_FOUND` | 404 | No |
| `INVALID_REQUEST` | 400/409/422 | No |
| `VIDEO_NOT_READY` | 400 | Yes — transcoding is still running |
| `RATE_LIMITED` | 429 | Yes — after `retryAfterMs` |
| `NETWORK` / `TIMEOUT` | — | Yes |
| `SERVER_ERROR` | 5xx | Yes |
| `HTTP` | other | Depends on `retryable` |

```ts
import { OpenVodError } from '@openvod/server'

try {
  await vod.playback.createToken(videoId)
} catch (error) {
  if (error instanceof OpenVodError && error.code === 'VIDEO_NOT_READY') {
    return Response.json({ status: 'processing' }, { status: 202 })
  }
  throw error
}
```

`GET` requests and the two token endpoints retry automatically (idempotent, or
harmless to repeat). `PATCH` and `DELETE` do not: a retried timeout can hide an
outcome you need to know about.

## Configuration

```ts
new OpenVod({
  apiKey: 'sk_live_…',                 // required
  baseUrl: 'https://api.yourvod.com',  // required — no /v1 suffix
  timeoutMs: 30_000,                   // default 30s
  maxRetries: 2,                       // default 2
  fetchImpl: fetch,                    // injectable, for tests/proxies
})
```

Need a route this SDK does not model yet? `vod.request({ method, path, body })`
keeps the auth, timeout and error handling.

## Requirements

Node 18+, Bun, Deno, or any runtime with `fetch` and `crypto.subtle` (webhook
verification uses WebCrypto, so it works on Workers and edge runtimes too).
Zero runtime dependencies.

## License

Apache-2.0
