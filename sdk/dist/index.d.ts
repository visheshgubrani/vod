/**
 * VOD Uploader SDK Types
 */
/**
 * Configuration options for the VOD uploader
 */
interface ClipmuxUploaderConfig {
    /** Base URL of the VOD API (e.g., 'https://api.yourvod.com') */
    baseUrl: string;
    /** Upload token obtained from your backend */
    uploadToken: string;
    /** Number of parts to upload in parallel (default: 3) */
    concurrency?: number;
    /** Number of retry attempts for failed uploads (default: 3) */
    maxRetries?: number;
    /** Base delay for exponential backoff in ms (default: 1000) */
    retryDelay?: number;
}
/**
 * Upload options for a single file
 */
interface UploadOptions {
    /** Video title (optional, defaults to filename) */
    title?: string;
    /** Playback policy: 'public' or 'signed' (default: 'public') */
    playbackPolicy?: 'public' | 'signed';
    /** Generate subtitles for the video (default: false) */
    generateSubtitle?: boolean;
    /** Generate chapters for the video (default: false, requires generateSubtitle) */
    generateChapters?: boolean;
    /** Progress callback */
    onProgress?: (progress: UploadProgress) => void;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}
/**
 * Progress information during upload
 */
interface UploadProgress {
    /** Percentage complete (0-100) */
    percentage: number;
    /** Bytes uploaded so far */
    bytesUploaded: number;
    /** Total bytes to upload */
    bytesTotal: number;
    /** Current upload phase */
    phase: 'initializing' | 'uploading' | 'completing';
    /** Number of parts completed */
    partsCompleted: number;
    /** Total number of parts */
    partsTotal: number;
}
/**
 * Result of a successful upload
 */
interface UploadResult {
    /** Unique video ID */
    fileId: string;
    /** Video title */
    title: string;
    /** Current video status */
    status: 'uploading' | 'processing' | 'ready' | 'failed';
}
/**
 * API response for creating an upload
 */
interface CreateUploadResponse {
    upload_id: string;
    file_id: string;
    key: string;
    part_size: number;
    part_count: number;
    urls: Array<{
        part_number: number;
        url: string;
        size: number;
    }>;
}
/**
 * API response for completing an upload
 */
interface CompleteUploadResponse {
    location?: string;
    bucket?: string;
    key?: string;
    etag?: string;
    file_id: string;
}

/**
 * Clipmux Uploader - Main SDK Implementation
 *
 * Provides a simple API for uploading videos with:
 * - Automatic multipart chunking
 * - Parallel uploads for speed
 * - Progress tracking
 * - Retry logic with exponential backoff
 */

declare class ClipmuxUploader {
    private baseUrl;
    private uploadToken;
    private concurrency;
    private maxRetries;
    private retryDelay;
    constructor(config: ClipmuxUploaderConfig);
    /**
     * Upload a file to the VOD platform
     */
    upload(file: File, options?: UploadOptions): Promise<UploadResult>;
    /**
     * Abort an in-progress upload
     */
    abort(key: string, uploadId: string, fileId?: string): Promise<{
        aborted: boolean;
    }>;
    private createUpload;
    private uploadPartsParallel;
    private completeUpload;
}

export { ClipmuxUploader, type ClipmuxUploaderConfig, type CompleteUploadResponse, type CreateUploadResponse, type UploadOptions, type UploadProgress, type UploadResult };
