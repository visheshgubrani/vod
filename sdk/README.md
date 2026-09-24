# @clipmux/uploader

Browser uploads for a self-hosted [ClipMux](https://github.com/visheshgubrani/vod)
deployment. Large files are split into parts automatically, part URLs are
fetched just in time, and uploads survive a refresh.

Your API key never reaches the browser: your backend mints a short-lived
**upload token** (with [`@clipmux/server`](https://www.npmjs.com/package/@clipmux/server))
and the SDK uploads straight to your storage with it.

```bash
npm install @clipmux/uploader
```

## Quick start

```ts
import { ClipMuxUploader } from '@clipmux/uploader'

// 1. Your backend returns { uploadToken } — see "Minting tokens" below.
const { uploadToken } = await fetch('/api/upload-token').then((r) => r.json())

// 2. Upload from the browser.
const uploader = new ClipMuxUploader({
  baseUrl: 'https://api.yourvod.com', // your API origin — no /v1 suffix
  uploadToken,
})

const result = await uploader.upload(file, {
  title: 'My Video',
  onProgress: (p) => console.log(`${p.percentage}%`),
})

console.log(result.fileId) // poll it, or wait for the video.ready webhook
```

## Minting tokens (server side)

`POST /v1/upload/token` requires your API key, so it belongs on your server.
With `@clipmux/server` it is one call:

```ts
import { ClipMux } from '@clipmux/server'

const vod = new ClipMux({
  apiKey: process.env.CLIPMUX_API_KEY!,
  baseUrl: process.env.CLIPMUX_API_URL!, // your API origin, no /v1 suffix
})
const token = await vod.uploads.createToken({ expiresIn: '1h', maxFiles: 1 })

// The API's own field names — `upload_token`, `expires_at`.
return Response.json({ uploadToken: token.upload_token, expiresAt: token.expires_at })
```

An upload token is scoped to one organization, expires (24h max), and can cap
the number of files (`maxFiles`) and the size of each (`maxSizeBytes`). It is
only checked on `/create`, so an upload that started before expiry still
finishes — that is what makes hour-long uploads safe.

## Resumable uploads

`upload()` is the one-shot convenience call. When you need pause/resume, or want
to survive a page reload, use a session:

```ts
const session = uploader.startUpload(file, {
  title: 'Keynote',
  onProgress: (p) => setPercent(p.percentage),
})

session.pause() // stops scheduling parts; in-flight parts finish
session.resume()
await session.run()
```

The session is serializable — it holds no `File` handle and no presigned URLs,
both of which expire or cannot be serialized:

```ts
localStorage.setItem('upload', JSON.stringify(session))

// After a reload, with the file re-selected:
const state = JSON.parse(localStorage.getItem('upload')!)
const resumed = uploader.resumeUpload(state, file)
await resumed.run() // already-uploaded parts are skipped
```

`run()` resolves with:

```ts
{
  fileId,      // the video id — poll it or wait for the webhook
  status,      // 'processing'
  title,
  key,         // object key: needed to abort
  uploadId,    // multipart upload id: needed to abort
  bytesUploaded, partCount, partSize, etag?
}
```

## Cancelling

```ts
// An in-flight upload
const controller = new AbortController()
uploader.upload(file, { signal: controller.signal })
controller.abort()

// Or, for a session (also abandons the multipart upload server-side)
await session.cancel()

// Or, later, from what the upload returned — this deletes the abandoned
// parts, which storage keeps billing until they are removed.
await uploader.abort(result.key, result.uploadId, result.fileId)
```

## Errors

Every failure is an `ClipMuxError` with a stable `code` — match on that, not on
the message:

| `code` | Meaning | Retry? |
|---|---|---|
| `UPLOAD_TOKEN_EXPIRED` | Token lapsed before `/create` | Mint a new token |
| `UPLOAD_TOKEN_EXHAUSTED` | `maxFiles` budget spent | Mint a new token |
| `UPLOAD_TOKEN_INVALID` | Missing/unknown token | Fix the auth header |
| `UPLOADS_DISABLED` | The deployment has `UPLOADS_ENABLED=false` | No |
| `RATE_LIMITED` | API rate limit (429) | Yes — after `retryAfterMs` |
| `SIZE_MISMATCH` | Uploaded bytes ≠ declared size | Re-upload |
| `OBJECT_MISSING` | The object never landed in storage | Re-upload |
| `TOO_MANY_PARTS` | File needs more than 10 000 parts | No |
| `PART_URL_REJECTED` | A part URL was rejected after a refresh | Usually no |
| `PART_CONFIG_INVALID` | The server's part plan drifted mid-upload | No |
| `NETWORK` | `fetch` failed | Yes |
| `HTTP` | Any other non-2xx | Depends on `retryable` |

```ts
import { ClipMuxError } from '@clipmux/uploader'

try {
  await uploader.upload(file)
} catch (error) {
  if (error instanceof ClipMuxError && error.retryable) {
    // error.retryAfterMs is set when the API sent Retry-After
  }
  console.error(error.message, error.requestId) // requestId helps support
}
```

Aborts are not errors: `cancel()` and an aborted `signal` reject with
`UploadAbortedError` (`isUploadAbortedError(error)`).

## Configuration

```ts
new ClipMuxUploader({
  baseUrl: 'https://api.yourvod.com', // required, no /v1 suffix
  uploadToken: 'ut_…',                // required
  concurrency: 3,                     // parallel parts (default 3)
  maxRetries: 3,                      // retries per part (default 3)
  retryDelay: 1000,                   // backoff base, ms (default 1000)
  windowSize: 100,                    // part URLs per /parts call (max 100)
  presignRefreshMs: 2700000,          // refresh a window after 45 min
})
```

Upload options: `title`, `playbackPolicy` (`'public' | 'signed'`),
`generateSubtitle`, `generateChapters` (requires subtitles),
`filename`, `contentType`, `onProgress`, `signal`. Provider selection is deployment-wide.

## Requirements

- Anywhere with `fetch`, `Blob` and `AbortController`: browsers, Workers, and
  Node 18+. Pass a `Blob` plus `filename` outside the browser.
- **R2 CORS on your raw bucket must expose `ETag`.** Without
  `"ExposeHeaders": ["ETag"]` the browser cannot read the part ETags and
  `/complete` fails. See the repository README for the JSON to paste.

## License

Apache-2.0
