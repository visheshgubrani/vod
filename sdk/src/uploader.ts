/**
 * Clipmux Uploader - Main SDK Implementation
 *
 * Provides a simple API for uploading videos with:
 * - Automatic multipart chunking
 * - Parallel uploads for speed
 * - Progress tracking
 * - Retry logic with exponential backoff
 */

import type {
    ClipmuxUploaderConfig,
    UploadOptions,
    UploadProgress,
    UploadResult,
    CreateUploadResponse,
    CompleteUploadResponse,
    PartInfo,
} from './types'

export class ClipmuxUploader {
    private baseUrl: string
    private uploadToken: string
    private concurrency: number
    private maxRetries: number
    private retryDelay: number

    constructor(config: ClipmuxUploaderConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '') // Remove trailing slash
        this.uploadToken = config.uploadToken
        this.concurrency = config.concurrency ?? 3
        this.maxRetries = config.maxRetries ?? 3
        this.retryDelay = config.retryDelay ?? 1000
    }

    /**
     * Upload a file to the VOD platform
     */
    async upload(file: File, options: UploadOptions = {}): Promise<UploadResult> {
        const { title, playbackPolicy, generateSubtitle, generateChapters, onProgress, signal } = options

        // Check if already aborted
        if (signal?.aborted) {
            throw new Error('Upload aborted')
        }

        // Report initial progress
        onProgress?.({
            percentage: 0,
            bytesUploaded: 0,
            bytesTotal: file.size,
            phase: 'initializing',
            partsCompleted: 0,
            partsTotal: 0,
        })

        // Step 1: Create the upload and get presigned URLs
        const createResponse = await this.createUpload(file, title, playbackPolicy, generateSubtitle, generateChapters)

        const parts: PartInfo[] = createResponse.urls.map((u) => ({
            partNumber: u.part_number,
            url: u.url,
            size: u.size,
            completed: false,
        }))

        // Update progress with part count
        onProgress?.({
            percentage: 0,
            bytesUploaded: 0,
            bytesTotal: file.size,
            phase: 'uploading',
            partsCompleted: 0,
            partsTotal: parts.length,
        })

        // Step 2: Upload all parts in parallel
        let bytesUploaded = 0
        const completedParts: Array<{ part_number: number; etag: string }> = []

        await this.uploadPartsParallel(
            file,
            parts,
            createResponse.part_size,
            signal,
            (partNumber, etag, partSize) => {
                bytesUploaded += partSize
                completedParts.push({ part_number: partNumber, etag })

                onProgress?.({
                    percentage: Math.round((bytesUploaded / file.size) * 100),
                    bytesUploaded,
                    bytesTotal: file.size,
                    phase: 'uploading',
                    partsCompleted: completedParts.length,
                    partsTotal: parts.length,
                })
            },
        )

        // Step 3: Complete the upload
        onProgress?.({
            percentage: 99,
            bytesUploaded: file.size,
            bytesTotal: file.size,
            phase: 'completing',
            partsCompleted: parts.length,
            partsTotal: parts.length,
        })

        const completeResponse = await this.completeUpload(
            createResponse.key,
            createResponse.upload_id,
            createResponse.file_id,
            completedParts,
        )

        // Final progress
        onProgress?.({
            percentage: 100,
            bytesUploaded: file.size,
            bytesTotal: file.size,
            phase: 'completing',
            partsCompleted: parts.length,
            partsTotal: parts.length,
        })

        return {
            fileId: completeResponse.file_id,
            title: title || file.name,
            status: 'processing',
        }
    }

    /**
     * Abort an in-progress upload
     */
    async abort(
        key: string,
        uploadId: string,
        fileId?: string,
    ): Promise<{ aborted: boolean }> {
        const response = await fetch(`${this.baseUrl}/v1/upload/abort`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `UploadToken ${this.uploadToken}`,
            },
            body: JSON.stringify({
                key,
                upload_id: uploadId,
                file_id: fileId,
            }),
        })

        if (!response.ok) {
            const error = await response.json().catch(() => ({}))
            throw new Error(error.error || `Abort failed: ${response.status}`)
        }

        return response.json()
    }

    // ===============================
    // Private Methods
    // ===============================

    private async createUpload(
        file: File,
        title?: string,
        playbackPolicy?: 'public' | 'signed',
        generateSubtitle?: boolean,
        generateChapters?: boolean,
    ): Promise<CreateUploadResponse> {
        const response = await fetch(`${this.baseUrl}/v1/upload/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `UploadToken ${this.uploadToken}`,
            },
            body: JSON.stringify({
                filename: file.name,
                content_type: file.type || 'video/mp4',
                size: file.size,
                title: title || file.name,
                playback_policy: playbackPolicy || 'public',
                generate_subtitle: generateSubtitle || false,
                generate_chapters: generateChapters || false,
            }),
        })

        if (!response.ok) {
            const error = await response.json().catch(() => ({}))
            throw new Error(error.error || `Failed to create upload: ${response.status}`)
        }

        return response.json()
    }

    private async uploadPartsParallel(
        file: File,
        parts: PartInfo[],
        partSize: number,
        signal: AbortSignal | undefined,
        onPartComplete: (partNumber: number, etag: string, partSize: number) => void,
    ): Promise<void> {
        const queue = [...parts]
        const inFlight: Promise<void>[] = []

        const uploadPart = async (part: PartInfo): Promise<void> => {
            if (signal?.aborted) {
                throw new Error('Upload aborted')
            }

            const start = (part.partNumber - 1) * partSize
            const end = Math.min(start + part.size, file.size)
            const blob = file.slice(start, end)

            let lastError: Error | null = null
            for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
                try {
                    const response = await fetch(part.url, {
                        method: 'PUT',
                        body: blob,
                        signal,
                    })

                    if (!response.ok) {
                        throw new Error(`Part upload failed: ${response.status}`)
                    }

                    // Get ETag from response headers
                    const etag = response.headers.get('ETag') || ''
                    part.etag = etag.replace(/"/g, '')
                    part.completed = true

                    onPartComplete(part.partNumber, part.etag, part.size)
                    return
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err))

                    // Don't retry if aborted
                    if (signal?.aborted) {
                        throw lastError
                    }

                    // Exponential backoff
                    if (attempt < this.maxRetries) {
                        const delay = this.retryDelay * Math.pow(2, attempt)
                        await new Promise((resolve) => setTimeout(resolve, delay))
                    }
                }
            }

            throw lastError || new Error('Part upload failed after retries')
        }

        // Process the queue with concurrency limit
        while (queue.length > 0 || inFlight.length > 0) {
            // Start new uploads up to concurrency limit
            while (queue.length > 0 && inFlight.length < this.concurrency) {
                const part = queue.shift()!
                const promise = uploadPart(part).then(
                    () => {
                        const idx = inFlight.indexOf(promise)
                        if (idx !== -1) inFlight.splice(idx, 1)
                    },
                    (err) => {
                        const idx = inFlight.indexOf(promise)
                        if (idx !== -1) inFlight.splice(idx, 1)
                        throw err
                    },
                )
                inFlight.push(promise)
            }

            // Wait for at least one to complete
            if (inFlight.length > 0) {
                await Promise.race(inFlight)
            }
        }
    }

    private async completeUpload(
        key: string,
        uploadId: string,
        fileId: string,
        parts: Array<{ part_number: number; etag: string }>,
    ): Promise<CompleteUploadResponse> {
        const response = await fetch(`${this.baseUrl}/v1/upload/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `UploadToken ${this.uploadToken}`,
            },
            body: JSON.stringify({
                key,
                upload_id: uploadId,
                file_id: fileId,
                parts,
            }),
        })

        if (!response.ok) {
            const error = await response.json().catch(() => ({}))
            throw new Error(error.error || `Failed to complete upload: ${response.status}`)
        }

        return response.json()
    }
}
