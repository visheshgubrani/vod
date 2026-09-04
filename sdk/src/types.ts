/**
 * VOD Uploader SDK Types
 */

/**
 * Configuration options for the VOD uploader
 */
export interface ClipmuxUploaderConfig {
    /** Base URL of the VOD API (e.g., 'https://api.yourvod.com') */
    baseUrl: string
    /** Upload token obtained from your backend */
    uploadToken: string
    /** Number of parts to upload in parallel (default: 3) */
    concurrency?: number
    /** Number of retry attempts for failed uploads (default: 3) */
    maxRetries?: number
    /** Base delay for exponential backoff in ms (default: 1000) */
    retryDelay?: number
    /** Presigned URLs are fetched in windows of this size (default: 32).
     *  Each window is fetched right before its parts upload, so presigned
     *  URLs never expire mid-upload. Must be <= 100 (server cap). */
    windowSize?: number
    /** Injectable fetch (defaults to global fetch) — for tests/proxies. */
    fetchImpl?: typeof fetch
}

/**
 * Upload options for a single file
 */
export interface UploadOptions {
    /** Video title (optional, defaults to filename) */
    title?: string
    /** Playback policy: 'public' or 'signed' (default: 'public') */
    playbackPolicy?: 'public' | 'signed'
    /** Generate subtitles for the video (default: false) */
    generateSubtitle?: boolean
    /** Generate chapters for the video (default: false, requires generateSubtitle) */
    generateChapters?: boolean
    /** Progress callback */
    onProgress?: (progress: UploadProgress) => void
    /** Abort signal for cancellation */
    signal?: AbortSignal
}

/**
 * Progress information during upload
 */
export interface UploadProgress {
    /** Percentage complete (0-100) */
    percentage: number
    /** Bytes uploaded so far */
    bytesUploaded: number
    /** Total bytes to upload */
    bytesTotal: number
    /** Current upload phase */
    phase: 'initializing' | 'uploading' | 'completing'
    /** Number of parts completed */
    partsCompleted: number
    /** Total number of parts */
    partsTotal: number
}

/**
 * Result of a successful upload
 */
export interface UploadResult {
    /** Unique video ID */
    fileId: string
    /** Video title */
    title: string
    /** Current video status */
    status: 'uploading' | 'processing' | 'ready' | 'failed'
}

/**
 * API response for creating an upload
 */
export interface CreateUploadResponse {
    upload_id: string
    file_id: string
    key: string
    part_size: number
    part_count: number
    /**
     * Optional presigned URLs returned by the create endpoint. Newer servers
     * omit these (URLs are fetched windowed via /parts); keep it optional for
     * backward compatibility with servers that still pre-mint them.
     */
    urls?: Array<{
        part_number: number
        url: string
        size: number
    }>
}

/**
 * One window of presigned part URLs (POST /v1/upload/parts response)
 */
export interface PartsWindow {
    part_size: number
    part_count: number
    urls: Array<{
        part_number: number
        url: string
        size: number
    }>
}

/**
 * API response for completing an upload
 */
export interface CompleteUploadResponse {
    location?: string
    bucket?: string
    key?: string
    etag?: string
    file_id: string
}

/**
 * Part upload tracking
 */
export interface PartInfo {
    partNumber: number
    url: string
    size: number
    etag?: string
    completed: boolean
}
