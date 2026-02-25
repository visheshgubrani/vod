# B2B Video Upload Integration Guide

Integrate video uploads into your application using the Clipmux platform and SDK.

## Architecture

```
Your Backend                    Clipmux API                 R2 Storage
     │                               │                          │
     ├── /v1/upload/token ──────────▶│                          │
     │   (API Key auth)              │                          │
     │◀───── upload_token ───────────┤                          │
     │                               │                          │
     ▼                               │                          │
Your Frontend                        │                          │
     │                               │                          │
     └── @clipmux/uploader SDK ─────▶│─────── presigned ───────▶│
         (handles everything)        │                          │
                                     │                          │
                                     │◀──── video.ready ────────┤
                                     │       webhook            │
```

---

## Quick Start

### 1. Install SDK

```bash
npm install @clipmux/uploader
```

### 2. Backend: Generate Upload Token

```typescript
// POST /api/upload-token
const response = await fetch('https://api.clipmux.com/v1/upload/token', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.CLIPMUX_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ expires_in: '1h', max_files: 1 }),
})

const { upload_token, expires_at } = await response.json()
return { uploadToken: upload_token, expiresAt: expires_at }
```

### 3. Frontend: Upload with SDK

```typescript
import { ClipmuxUploader } from '@clipmux/uploader'

// Get token from your backend
const { uploadToken } = await fetch('/api/upload-token').then(r => r.json())

// Upload file
const uploader = new ClipmuxUploader({
  baseUrl: 'https://api.clipmux.com',
  uploadToken,
})

const result = await uploader.upload(file, {
  title: 'My Video',
  onProgress: (p) => console.log(`${p.percentage}%`),
})

console.log('Video ID:', result.fileId)  // Save this!
```

### 4. Backend: Handle Webhooks

```typescript
// POST /webhooks/clipmux
app.post('/webhooks/clipmux', (req, res) => {
  const { event, data } = req.body

  if (event === 'video.ready') {
    await db.updateVideo(data.videoId, {
      status: 'ready',
      hlsUrl: data.hlsUrl,
      duration: data.duration,
    })
  }

  res.json({ received: true })
})
```

---

## SDK Reference

### ClipmuxUploader

```typescript
const uploader = new ClipmuxUploader({
  baseUrl: 'https://api.clipmux.com',
  uploadToken: 'ut_xxx',
  chunkSize: 5 * 1024 * 1024,  // Optional: 5MB default
  concurrency: 3,              // Optional: parallel uploads
})
```

### upload()

```typescript
const result = await uploader.upload(file, {
  title: 'My Video',
  playbackPolicy: 'public',  // or 'signed'
  signal: abortController.signal,
  onProgress: (progress) => {
    console.log(`${progress.percentage}%`)
    console.log(`${progress.uploadedBytes}/${progress.totalBytes}`)
  },
})

// result: { fileId, status: 'processing', key }
```

### Cancellation

```typescript
const controller = new AbortController()

// Start upload
uploader.upload(file, { signal: controller.signal })

// Cancel anytime
controller.abort()
```

---

## Webhook Events

| Event | When | Payload |
|-------|------|---------|
| `video.ready` | ✅ Ready for playback | `videoId`, `hlsUrl`, `thumbnailUrl`, `duration` |
| `video.failed` | Transcoding failed | `videoId`, `error` |
| `video.processing` | Transcoding started | `videoId` |

### Signature Verification

```typescript
const signature = req.headers['x-webhook-signature']
const timestamp = req.headers['x-webhook-timestamp']

const expected = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(`${timestamp}.${JSON.stringify(req.body)}`)
  .digest('hex')

if (signature !== `sha256=${expected}`) {
  return res.status(401).send('Invalid signature')
}
```

---

## Video Playback

After `video.ready`, get a signed playback URL:

```typescript
// Backend: GET /api/video/:id/playback
const response = await fetch(
  `https://api.clipmux.com/v1/video/${videoId}/playback-token`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CLIPMUX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      viewer_ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim(),
      viewer_user_agent: req.headers['user-agent'],
    }),
  }
)

const { playback_url } = await response.json()
// playback_url: https://media.clipmux.com/videos/.../playlist.m3u8?token=...
```

Always forward the end-user IP and User-Agent from your app request when minting playback tokens, so token binding works correctly.

### Frontend Player (HLS.js)

```typescript
import Hls from 'hls.js'

const video = document.querySelector('video')
const hls = new Hls()
hls.loadSource(playbackUrl)
hls.attachMedia(video)
```

---

## API Endpoints Summary

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /v1/upload/token` | API Key | Generate upload token |
| `POST /v1/video/:id/playback-token` | API Key | Get signed playback URL |
| `GET /v1/video/:id` | API Key | Get video details |
| `DELETE /v1/video/:id` | API Key | Delete video |

> **Note**: The SDK handles all upload operations (`/create`, `/parts`, `/complete`) automatically.

---

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Upload token has expired` | Token > lifetime | Request new token |
| `Upload token has been fully used` | max_files reached | Request new token |
| `Invalid Authorization header` | Wrong token format | Use `UploadToken ut_xxx` |
