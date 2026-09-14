/**
 * OpenVOD Uploader SDK
 *
 * Uploads videos to a self-hosted OpenVOD deployment with:
 * - Automatic multipart chunking for large files
 * - Windowed presigned-URL fetching (URLs never expire mid-upload)
 * - Parallel uploads for maximum speed
 * - Progress tracking, pause/resume, and resumable sessions
 * - Automatic retry with exponential backoff (honours `Retry-After`)
 * - AbortSignal support for cancellation
 * - Typed errors (`OpenVodError.code`) instead of message matching
 *
 * @example
 * ```typescript
 * import { OpenVodUploader } from '@openvod/uploader'
 *
 * // Your backend mints this with an API key — see @openvod/server.
 * const { uploadToken } = await fetch('/api/upload-token').then((r) => r.json())
 *
 * const uploader = new OpenVodUploader({
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
    OpenVodUploader,
    UploadSession,
    computePartPlan,
    resolveContentType,
    resolveFilename,
} from './uploader'
export type { OpenVodUploaderInternals } from './uploader'

export {
    OpenVodError,
    UploadAbortedError,
    isUploadAbortedError,
    isRetryableCode,
    codeForResponse,
    parseRetryAfter,
} from './errors'
export type { OpenVodErrorCode, OpenVodErrorOptions } from './errors'

export type {
    OpenVodUploaderConfig,
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
