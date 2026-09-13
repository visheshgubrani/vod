# @openvod/uploader

A lightweight SDK for uploading videos to a self-hosted OpenVOD API with windowed multipart upload support.

## Features

- Automatic multipart chunking — large files are split automatically
- Windowed presigned URLs — URLs are fetched just-in-time so they never expire mid-upload
- Parallel uploads — multiple parts at once
- Progress tracking — real-time callbacks
- Automatic retry — exponential backoff for failed parts
- Cancellation — AbortController support
- TypeScript first — full type definitions included

## Installation

```bash
npm install @openvod/uploader
```

## Quick Start

```typescript
import { OpenVodUploader } from '@openvod/uploader'

const uploadToken = await getUploadTokenFromYourBackend()

const uploader = new OpenVodUploader({
  baseUrl: 'https://api.yourvod.com',
  uploadToken,
})

const result = await uploader.upload(file, {
  title: 'My Video',
  onProgress: (progress) => {
    console.log(`${progress.percentage}% uploaded`)
  },
})

console.log(`Video ID: ${result.fileId}`)
```

## Authentication Flow

1. **Your backend** requests an upload token using your API key:

   ```bash
   curl -X POST https://api.yourvod.com/v1/upload/token \
     -H "Authorization: Bearer sk_live_YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"expires_in": "1h", "max_files": 1}'
   ```

2. **Your frontend** uses the token to upload directly:

   ```typescript
   const uploader = new OpenVodUploader({
     baseUrl: 'https://api.yourvod.com',
     uploadToken: 'ut_abc123...',
   })
   ```

## Configuration Options

```typescript
const uploader = new OpenVodUploader({
  baseUrl: 'https://api.yourvod.com',
  uploadToken: 'ut_abc123...',

  concurrency: 3,
  maxRetries: 3,
  retryDelay: 1000,
  windowSize: 32,
})
```

## Upload Options

```typescript
await uploader.upload(file, {
  title: 'My Video',
  playbackPolicy: 'public',
  generateSubtitle: true,
  generateChapters: true,
  onProgress: (progress) => {
    // progress.percentage (0-100)
    // progress.bytesUploaded
    // progress.bytesTotal
    // progress.phase: 'initializing' | 'uploading' | 'completing'
    // progress.partsCompleted
    // progress.partsTotal
  },
  signal: abortController.signal,
})
```

## Cancellation

```typescript
const controller = new AbortController()

const uploadPromise = uploader.upload(file, {
  signal: controller.signal,
})

setTimeout(() => controller.abort(), 5000)

try {
  await uploadPromise
} catch (err) {
  if (err.message === 'Upload aborted') {
    console.log('Upload was cancelled')
  }
}
```

## License

Apache-2.0
