/**
 * ClipMux Uploader SDK
 *
 * Uploads videos to a self-hosted ClipMux deployment with:
 * - Automatic multipart chunking for large files
 * - Windowed presigned-URL fetching (URLs never expire mid-upload)
 * - Parallel uploads for maximum speed
 * - Progress tracking, pause/resume, and resumable sessions
 * - Automatic retry with exponential backoff (honours `Retry-After`)
 * - AbortSignal support for cancellation
 * - Typed errors (`ClipMuxError.code`) instead of message matching
 *
 * @example
 * ```typescript
 * import { ClipMuxUploader } from '@clipmux/uploader'
 *
 * // Your backend mints this with an API key — see @clipmux/server.
 * const { uploadToken } = await fetch('/api/upload-token').then((r) => r.json())
 *
 * const uploader = new ClipMuxUploader({
 *   baseUrl: 'https://api.yourvod.com',
 *   uploadToken,
 * })
 *
 * const result = await uploader.upload(file, {
 *   title: 'My Video',
 *   onProgress: (progress) => console.log(`${progress.percentage}% uploaded`),
 * })
 *
 * console.log(`Video ID: ${result.fileId}`)
 * ```
 *
 * @example Resumable upload
 * ```typescript
 * const session = uploader.startUpload(file, { onProgress })
 * session.pause()
 * localStorage.setItem('upload', JSON.stringify(session))
 * // ... later, or after a reload
 * const resumed = uploader.resumeUpload(
 *   JSON.parse(localStorage.getItem('upload')!),
 *   file,
 * )
 * await resumed.run()
 * ```
 */

export {
    ClipMuxUploader,
    UploadSession,
    computePartPlan,
    resolveContentType,
    resolveFilename,
} from './uploader'
export type { ClipMuxUploaderInternals } from './uploader'

export {
    ClipMuxError,
    UploadAbortedError,
    isUploadAbortedError,
    isRetryableCode,
    codeForResponse,
    parseRetryAfter,
} from './errors'
export type { ClipMuxErrorCode, ClipMuxErrorOptions } from './errors'

export type {
    ClipMuxUploaderConfig,
    UploadOptions,
    UploadProgress,
    UploadResult,
    UploadSource,
    CreateUploadResponse,
    CompleteUploadResponse,
    PartsWindow,
    PartInfo,
    CompletedPart,
    ReUploadState,
} from './types'
