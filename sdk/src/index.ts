/**
 * Clipmux Uploader SDK
 *
 * A lightweight SDK for uploading videos to Clipmux with:
 * - Automatic multipart chunking for large files
 * - Parallel uploads for maximum speed
 * - Progress tracking with callbacks
 * - Automatic retry with exponential backoff
 * - AbortController support for cancellation
 *
 * @example
 * ```typescript
 * import { ClipmuxUploader } from '@clipmux/uploader'
 *
 * const uploader = new ClipmuxUploader({
 *   baseUrl: 'https://api.clipmux.com',
 *   uploadToken: 'ut_abc123...',
 * })
 *
 * const result = await uploader.upload(file, {
 *   title: 'My Video',
 *   onProgress: (progress) => {
 *     console.log(`${progress.percentage}% uploaded`)
 *   },
 * })
 *
 * console.log(`Video ID: ${result.fileId}`)
 * ```
 */

export { ClipmuxUploader } from './uploader'
export type {
    ClipmuxUploaderConfig,
    UploadOptions,
    UploadProgress,
    UploadResult,
    CreateUploadResponse,
    CompleteUploadResponse,
} from './types'
