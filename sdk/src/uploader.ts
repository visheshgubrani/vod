/**
 * VOD Uploader - Main SDK Implementation
 *
 * Provides a simple API for uploading videos with:
 * - Automatic multipart chunking with WINDOWED presigned-URL fetching:
 *   part URLs are requested from /v1/upload/parts in small batches right
 *   before they are needed, so a slow upload never outlives its presigned
 *   URLs and the create payload never carries 10k URLs.
 * - Parallel uploads with retry + exponential backoff
 * - Progress tracking and AbortSignal support
 */

import type {
    ClipmuxUploaderConfig,
    UploadOptions,
    UploadProgress,
    UploadResult,
    CreateUploadResponse,
    CompleteUploadResponse,
    PartsWindow,
} from './types'

const DEFAULT_WINDOW_SIZE = 32
/** Server cap for one /parts request (kept in sync with the API). */
const MAX_WINDOW_SIZE = 100

export class ClipmuxUploader {
    private baseUrl: string
    private uploadToken: string
    private concurrency: number
    private maxRetries: number
    private retryDelay: number
    private windowSize: number
    private http: typeof fetch

    constructor(config: ClipmuxUploaderConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '') // Remove trailing slash
        this.uploadToken = config.uploadToken
        this.concurrency = config.concurrency ?? 3
        this.maxRetries = config.maxRetries ?? 3
        this.retryDelay = config.retryDelay ?? 1000
        this.windowSize = Math.min(
            MAX_WINDOW_SIZE,
            Math.max(1, Math.floor(config.windowSize ?? DEFAULT_WINDOW_SIZE)),
        )
        this.http = config.fetchImpl ?? ((...args) => fetch(...args))
    }

    /**
     * Upload a file to the VOD platform
     */
    async upload(file: File, options: UploadOptions = {}): Promise<UploadResult> {
        const { title, playbackPolicy, generateSubtitle, generateChapters, onProgress, signal } =
            options

        if (signal?.aborted) {
            throw new Error('Upload aborted')
        }

        const bytesTotal = file.size
        onProgress?.({
            percentage: 0,
            bytesUploaded: 0,
            bytesTotal,
            phase: 'initializing',
            partsCompleted: 0,
            partsTotal: 0,
        })

        // Step 1: create the upload (server decides part size / count and no
        // longer pre-mints URLs for every part).
        const create = await this.createUpload(
            file,
            title,
            playbackPolicy,
            generateSubtitle,
            generateChapters,
        )

        const partSize = create.part_size
        const partCount = create.part_count
        if (!Number.isInteger(partSize) || partSize <= 0 || !Number.isInteger(partCount) || partCount <= 0) {
            throw new Error('Server returned an invalid part configuration')
        }
        // Legacy servers may still include all URLs up front; preload them.
        const preloaded = new Map<number, { url: string; size: number }>()
        for (const part of create.urls ?? []) {
            preloaded.set(part.part_number, { url: part.url, size: part.size })
        }

        onProgress?.({
            percentage: 0,
            bytesUploaded: 0,
            bytesTotal,
            phase: 'uploading',
            partsCompleted: 0,
            partsTotal: partCount,
        })

        // Step 2: upload all parts in windows, fetching presigned URLs just
        // in time from /parts.
        let bytesUploaded = 0
        const completedParts: Array<{ part_number: number; etag: string }> = []

        for (let start = 1; start <= partCount; start += this.windowSize) {
            const windowParts: number[] = []
            for (let n = start; n < start + this.windowSize && n <= partCount; n++) {
                windowParts.push(n)
            }

            const urlsByNumber = new Map<number, string>()
            for (const partNumber of windowParts) {
                const known = preloaded.get(partNumber)
                if (known) urlsByNumber.set(partNumber, known.url)
            }

            const fetchWindow = async (): Promise<void> => {
                const window = await this.requestParts(
                    create.key,
                    create.upload_id,
                    create.file_id,
                    file.size,
                    partSize,
                    windowParts,
                )
                for (const part of window.urls) {
                    urlsByNumber.set(part.part_number, part.url)
                }
            }

            if (urlsByNumber.size < windowParts.length) {
                await fetchWindow()
            }

            await this.uploadWindow(
                file,
                windowParts,
                urlsByNumber,
                partSize,
                file.size,
                signal,
                () => fetchWindow(), // re-fetch on presign expiry (403/401)
                (partNumber, etag, partSize) => {
                    bytesUploaded += partSize
                    completedParts.push({ part_number: partNumber, etag })
                    onProgress?.({
                        percentage: bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 100,
                        bytesUploaded,
                        bytesTotal,
                        phase: 'uploading',
                        partsCompleted: completedParts.length,
                        partsTotal: partCount,
                    })
                },
            )
        }

        // Step 3: complete the upload
        onProgress?.({
            percentage: 99,
            bytesUploaded,
            bytesTotal,
            phase: 'completing',
            partsCompleted: completedParts.length,
            partsTotal: partCount,
        })

        const complete = await this.completeUpload(create.key, create.upload_id, create.file_id, completedParts)

        onProgress?.({
            percentage: 100,
            bytesUploaded,
            bytesTotal,
            phase: 'completing',
            partsCompleted: completedParts.length,
            partsTotal: partCount,
        })

        return {
            fileId: complete.file_id,
            title: title || file.name,
            status: 'processing',
        }
    }

    /**
     * Abort an in-progress upload (server-side multipart abort + optional
     * video record deletion)
     */
    async abort(key: string, uploadId: string, fileId?: string): Promise<{ aborted: boolean }> {
        const response = await this.jsonRequest('/v1/upload/abort', {
            key,
            upload_id: uploadId,
            file_id: fileId,
        })
        if (!response.ok) throw new Error(await this.errorMessage(response, 'Abort failed'))
        return response.json()
    }

    // =============================== Internals ==============================

    private async jsonRequest(path: string, body: unknown): Promise<Response> {
        return this.http(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `UploadToken ${this.uploadToken}`,
            },
            body: JSON.stringify(body),
        })
    }

    private async errorMessage(response: Response, fallback: string): Promise<string> {
        const data = await response.json().catch(() => ({}))
        const message = (data as { error?: string }).error
        return message || `${fallback}: ${response.status}`
    }

    private async createUpload(
        file: File,
        title?: string,
        playbackPolicy?: 'public' | 'signed',
        generateSubtitle?: boolean,
        generateChapters?: boolean,
    ): Promise<CreateUploadResponse> {
        const response = await this.jsonRequest('/v1/upload/create', {
            filename: file.name,
            content_type: file.type || 'video/mp4',
            size: file.size,
            title: title || file.name,
            playback_policy: playbackPolicy || 'public',
            generate_subtitle: generateSubtitle || false,
            generate_chapters: generateChapters || false,
        })
        if (!response.ok) throw new Error(await this.errorMessage(response, 'Failed to create upload'))
        return response.json()
    }

    private async requestParts(
        key: string,
        uploadId: string,
        fileId: string,
        size: number,
        partSize: number,
        partNumbers: number[],
    ): Promise<PartsWindow> {
        const response = await this.jsonRequest('/v1/upload/parts', {
            key,
            upload_id: uploadId,
            file_id: fileId,
            size,
            part_size: partSize,
            part_numbers: partNumbers,
        })
        if (!response.ok) throw new Error(await this.errorMessage(response, 'Failed to fetch part URLs'))
        return response.json()
    }

    private async uploadWindow(
        file: File,
        partNumbers: number[],
        urlsByNumber: Map<number, string>,
        declaredPartSize: number,
        fileSize: number,
        signal: AbortSignal | undefined,
        refetchWindow: () => Promise<void>,
        onPartComplete: (partNumber: number, etag: string, partSize: number) => void,
    ): Promise<void> {
        const queue = [...partNumbers]
        const inFlight: Promise<void>[] = []

        const uploadPart = async (partNumber: number): Promise<void> => {
            if (signal?.aborted) throw new Error('Upload aborted')

            const start = (partNumber - 1) * declaredPartSize
            const end = Math.min(start + declaredPartSize, fileSize)
            const blob = file.slice(start, end)

            let lastError: Error | null = null
            let refreshed = false

            for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
                try {
                    let url = urlsByNumber.get(partNumber)
                    if (!url) throw new Error(`No presigned URL for part ${partNumber}`)

                    const response = await this.http(url, { method: 'PUT', body: blob, signal })

                    if (response.status === 401 || response.status === 403) {
                        // Presigned URL expired (or was revoked) mid-window —
                        // re-fetch the whole window once, then retry.
                        if (!refreshed) {
                            refreshed = true
                            await refetchWindow()
                            continue
                        }
                        throw new Error(`Part upload rejected (${response.status}) after URL refresh`)
                    }

                    if (!response.ok) throw new Error(`Part upload failed: ${response.status}`)

                    const etag = (response.headers.get('ETag') || '').replace(/"/g, '')
                    urlsByNumber.delete(partNumber)
                    onPartComplete(partNumber, etag, end - start)
                    return
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err))
                    if (signal?.aborted) throw lastError
                    if (attempt < this.maxRetries) {
                        const delay = this.retryDelay * 2 ** attempt
                        await new Promise((resolve) => setTimeout(resolve, delay))
                    }
                }
            }
            throw lastError || new Error(`Part upload failed after retries: ${partNumber}`)
        }

        while (queue.length > 0 || inFlight.length > 0) {
            while (queue.length > 0 && inFlight.length < this.concurrency) {
                const partNumber = queue.shift()!
                const promise = uploadPart(partNumber).then(
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
        const response = await this.jsonRequest('/v1/upload/complete', {
            key,
            upload_id: uploadId,
            file_id: fileId,
            parts,
        })
        if (!response.ok) throw new Error(await this.errorMessage(response, 'Failed to complete upload'))
        return response.json()
    }
}
