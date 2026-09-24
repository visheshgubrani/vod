/**
 * ClipMux uploader SDK types.
 *
 * The wire types (`CreateUploadResponse`, `PartsWindow`, `CompleteUploadResponse`)
 * mirror the public API in `server/src/routes/upload-public.ts`; the request
 * types are the SDK's own ergonomic surface (camelCase, optionals) and are
 * translated in `uploader.ts`.
 */

/** A file to upload. `File` in the browser, `Blob` + `filename` elsewhere. */
export type UploadSource = File | Blob

/** Configuration options for the uploader. */
export interface ClipMuxUploaderConfig {
    /**
     * Origin of the ClipMux API, without the `/v1` suffix
     * (e.g. `https://api.yourvod.com`). The public API is mounted at the root.
     */
    baseUrl: string
    /** Upload token obtained from your backend (`ut_…`). */
    uploadToken: string
    /** Number of parts to upload in parallel (default: 3). */
    concurrency?: number
    /** Number of retry attempts per part (default: 3). */
    maxRetries?: number
    /** Base delay for exponential backoff, in milliseconds (default: 1000). */
    retryDelay?: number
    /**
     * Presigned URLs are fetched in windows of this size (default: 100).
     * Each window is fetched right before its parts upload, so presigned URLs
     * never expire mid-upload. Must be <= 100 (server cap).
     */
    windowSize?: number
    /**
     * Re-fetch a window's URLs after this many ms, even without a rejection.
     * Presigned part URLs are valid for 1 hour; the default (45 min) leaves
     * margin for a slow window. Never set this above the server's TTL.
     */
    presignRefreshMs?: number
    /** Injectable fetch (defaults to global fetch) — for tests/proxies. */
    fetchImpl?: typeof fetch
    /** Test seam: override backoff waiting. Defaults to `setTimeout`. */
    delayImpl?: (ms: number) => Promise<void>
}

/** Upload options for a single file. */
export interface UploadOptions {
    /** Video title (optional, defaults to filename). */
    title?: string
    /** Playback policy: 'public' or 'signed' (default: 'public'). */
    playbackPolicy?: 'public' | 'signed'
    /** Generate subtitles for the video (default: false). */
    generateSubtitle?: boolean
    /** Generate chapters (default: false; the server forces this off without subtitles). */
    generateChapters?: boolean
    /** Override the filename sent to the API (defaults to `file.name`). */
    filename?: string
    /** Override the content type (defaults to `file.type`, then the extension). */
    contentType?: string
    /** Progress callback, invoked on every state change (including pauses). */
    onProgress?: (progress: UploadProgress) => void
    /** Abort signal for cancellation. */
    signal?: AbortSignal
}

/** Progress information during upload. */
export interface UploadProgress {
    /** Percentage complete (0-100). */
    percentage: number
    /** Bytes uploaded so far (parts confirmed by the server). */
    bytesUploaded: number
    /** Total bytes to upload. */
    bytesTotal: number
    /** Current upload phase. `paused` is entered only via `pause()`. */
    phase: 'initializing' | 'uploading' | 'paused' | 'completing'
    /** Number of parts completed. */
    partsCompleted: number
    /** Total number of parts. */
    partsTotal: number
}

/** Result of a successful upload. */
export interface UploadResult {
    /** Unique video ID. Poll `/v1/video/:id` (or wait for `video.ready`). */
    fileId: string
    /** Video title. */
    title: string
    /** Current video status — `processing` once the upload completed. */
    status: 'uploading' | 'processing' | 'ready' | 'failed'
    /**
     * Object key of the uploaded original. Together with `uploadId` this is
     * what `abort()` needs, and it is never derivable from the file.
     */
    key: string
    /** Multipart upload id (needed to abort a stranded upload). */
    uploadId: string
    /** ETag of the completed object, when the storage backend returned one. */
    etag?: string
    /** Bytes confirmed uploaded. */
    bytesUploaded: number
    /** Parts in the upload. */
    partCount: number
    /** Size of every part but the last. */
    partSize: number
}

/** API response for creating an upload (POST /v1/upload/create). */
export interface CreateUploadResponse {
    upload_id: string
    file_id: string
    key: string
    part_size: number
    part_count: number
    /**
     * Optional presigned URLs returned by the create endpoint. Current servers
     * omit these (URLs are fetched windowed via /parts); kept optional for
     * backward compatibility with servers that still pre-mint them.
     */
    urls?: Array<{
        part_number: number
        url: string
        size: number
    }>
}

/** One window of presigned part URLs (POST /v1/upload/parts response). */
export interface PartsWindow {
    part_size: number
    part_count: number
    urls: Array<{
        part_number: number
        url: string
        size: number
    }>
}

/** API response for completing an upload (POST /v1/upload/complete). */
export interface CompleteUploadResponse {
    location?: string
    bucket?: string
    key?: string
    etag?: string
    file_id: string
    /** True when the server saw the video already processing/ready. */
    skipped?: boolean
}

/** Part upload tracking. */
export interface PartInfo {
    partNumber: number
    url: string
    size: number
    etag?: string
    completed: boolean
}

/** One completed part, as sent to `/complete`. */
export interface CompletedPart {
    part_number: number
    etag: string
}

/**
 * A serializable in-flight upload.
 *
 * `JSON.stringify(session)` is safe to put in `localStorage` (it holds no File
 * handle and no presigned URLs, both of which expire or are un-serializable),
 * so a reloaded page can call `uploader.resumeUpload(state, file)` and skip
 * every part that already landed.
 */
export interface ReUploadState {
    /** State format version — bump when the shape changes. */
    version: 1
    key: string
    uploadId: string
    fileId: string
    partSize: number
    partCount: number
    filename: string
    fileSize: number
    contentType: string
    /** Parts already confirmed, with their ETags. */
    completedParts: CompletedPart[]
    bytesUploaded: number
    /** The options the original upload was started with. */
    options: {
        title?: string
        playbackPolicy?: 'public' | 'signed'
        generateSubtitle?: boolean
        generateChapters?: boolean
    }
}
