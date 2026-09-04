/**
 * OpenVOD Uploader SDK
 *
 * A lightweight SDK for uploading videos to OpenVOD with:
 * - Automatic multipart chunking for large files
 * - Windowed presigned-URL fetching (URLs never expire mid-upload)
 * - Parallel uploads for maximum speed
 * - Progress tracking with callbacks
 * - Automatic retry with exponential backoff
 * - AbortController support for cancellation
 *
 * @example
 * ```typescript
 * import { OpenVodUploader } from '@openvod/uploader'
 *
 * const uploader = new OpenVodUploader({
 *   baseUrl: 'https://api.yourvod.com',
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
/** Alias matching the @openvod/uploader package scope. */
export { ClipmuxUploader as OpenVodUploader } from './uploader'
export type {
    ClipmuxUploaderConfig,
    UploadOptions,
    UploadProgress,
    UploadResult,
    CreateUploadResponse,
    CompleteUploadResponse,
    PartsWindow,
    PartInfo,
} from './types'
