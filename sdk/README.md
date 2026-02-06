# @clipmux/uploader

A lightweight SDK for uploading videos to Clipmux with multipart upload support.

## Features

- 🚀 **Automatic multipart chunking** - Large files are split automatically
- ⚡ **Parallel uploads** - Upload multiple parts simultaneously for speed
- 📊 **Progress tracking** - Real-time progress with callbacks
- 🔄 **Automatic retry** - Exponential backoff for failed parts
- ❌ **Cancellation** - AbortController support for cancelling uploads
- 📝 **TypeScript first** - Full type definitions included

## Installation

```bash
npm install @clipmux/uploader
```

## Quick Start

```typescript
import { ClipmuxUploader } from '@clipmux/uploader'

// Get an upload token from your backend
const uploadToken = await getUploadTokenFromYourBackend()

// Create uploader instance
const uploader = new ClipmuxUploader({
  baseUrl: 'https://api.clipmux.com',
  uploadToken,
})

// Upload a file
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
   curl -X POST https://api.clipmux.com/v1/upload/token \
     -H "Authorization: Bearer sk_live_YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"expires_in": "1h", "max_files": 1}'
   ```

2. **Your frontend** uses the token to upload directly:
   ```typescript
   const uploader = new ClipmuxUploader({
     baseUrl: 'https://api.clipmux.com',
     uploadToken: 'ut_abc123...', // Token from step 1
   })
   ```

## Configuration Options

```typescript
const uploader = new ClipmuxUploader({
  // Required
  baseUrl: 'https://api.clipmux.com',
  uploadToken: 'ut_abc123...',

  // Optional
  concurrency: 3,     // Parts to upload in parallel (default: 3)
  maxRetries: 3,      // Retry attempts for failed parts (default: 3)
  retryDelay: 1000,   // Base delay for backoff in ms (default: 1000)
})
```

## Upload Options

```typescript
await uploader.upload(file, {
  title: 'My Video',           // Optional, defaults to filename
  playbackPolicy: 'public',    // 'public' or 'signed'
  onProgress: (progress) => {
    // progress.percentage (0-100)
    // progress.bytesUploaded
    // progress.bytesTotal
    // progress.phase: 'initializing' | 'uploading' | 'completing'
    // progress.partsCompleted
    // progress.partsTotal
  },
  signal: abortController.signal,  // For cancellation
})
```

## Cancellation

```typescript
const controller = new AbortController()

// Start upload
const uploadPromise = uploader.upload(file, {
  signal: controller.signal,
})

// Cancel after 5 seconds
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

MIT
