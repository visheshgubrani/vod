/**
 * ClipMux uploader — the client half of the public upload API.
 *
 * Talks to `/v1/upload/{create,parts,complete,abort}` with a short-lived
 * upload token, so no storage credential ever reaches the browser.
 *
 * Two properties shape this implementation:
 *
 *  - **Part URLs are fetched just in time, in windows.** The server caps a
 *    `/parts` request at 100 part numbers and presigns each URL for one hour;
 *    a 10 000-part upload therefore cannot pre-fetch them all. Windows are
 *    requested immediately before their parts are uploaded, and one window is
 *    re-fetched once if a PUT comes back 401/403.
 *  - **An upload is resumable.** The part plan, the completed parts with their
 *    ETags, and the multipart upload id are all serializable, so a reloaded
 *    page resumes instead of restarting. `startUpload()` returns that handle;
 *    `upload()` is the one-shot convenience wrapper over it.
 */

import {
    ClipMuxError,
    UploadAbortedError,
    codeForResponse,
    isRetryableCode,
    parseRetryAfter,
    readServerError,
} from './errors'
import type {
    CompleteUploadResponse,
    CompletedPart,
    CreateUploadResponse,
    ClipMuxUploaderConfig,
    PartsWindow,
    ReUploadState,
    UploadOptions,
    UploadProgress,
    UploadResult,
    UploadSource,
} from './types'

const DEFAULT_WINDOW_SIZE = 100
/** Server cap for one /parts request (kept in sync with the API). */
const MAX_WINDOW_SIZE = 100
/** Presigned part URLs are valid for 1 hour; refresh comfortably inside that. */
const DEFAULT_PRESIGN_REFRESH_MS = 45 * 60 * 1000
const STATE_VERSION = 1

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    ts: 'video/mp2t',
    m3u8: 'application/vnd.apple.mpegurl',
}

/** Best-effort content type: explicit > Blob type > extension > mp4. */
export function resolveContentType(file: UploadSource, override?: string): string {
    if (override) return override
    const type = typeof file.type === 'string' ? file.type : ''
    if (type) return type
    const name = resolveFilename(file, undefined)
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    return EXTENSION_CONTENT_TYPES[ext] ?? 'video/mp4'
}

/** Best-effort filename: override > File.name > a generic name. */
export function resolveFilename(file: UploadSource, override?: string): string {
    if (override) return override
    const name = (file as File).name
    if (typeof name === 'string' && name.length > 0) return name
    return 'upload.mp4'
}

/**
 * Split `size` bytes into parts using the server's plan.
 *
 * Kept pure and exported because the SDK's contract with `/parts` depends on
 * this arithmetic: a part whose range is computed differently from the
 * server's is a size mismatch that only surfaces at `/complete`.
 */
export function computePartPlan(
    size: number,
    partSize: number,
): { partNumber: number; start: number; end: number }[] {
    const plan: { partNumber: number; start: number; end: number }[] = []
    for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber++) {
        plan.push({ partNumber, start, end: Math.min(start + partSize, size) })
    }
    return plan
}

/** Human-readable one-liner for a thrown value (network errors are not Errors). */
function describe(value: unknown): string {
    if (value instanceof Error) return value.message
    return String(value)
}

/** Combine the caller's signal with the session's own (abort/cancel) signal. */
function linkSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {    if (!a) return b
    // AbortSignal.any is Node 20+/modern browsers; fall back for older ones.
    const anySignal = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
    if (typeof anySignal === 'function') return anySignal.call(AbortSignal, [a, b])

    const controller = new AbortController()
    const forward = () => controller.abort()
    if (a.aborted || b.aborted) {
        controller.abort()
    } else {
        a.addEventListener('abort', forward, { once: true })
        b.addEventListener('abort', forward, { once: true })
    }
    return controller.signal
}

/**
 * One file's upload as an addressable object.
 *
 * Created by `uploader.startUpload()` / `uploader.resumeUpload()`; `run()` is
 * the promise the one-shot `upload()` awaits.
 */
export class UploadSession {
    private readonly file: UploadSource
    private readonly filename: string
    private readonly contentType: string
    private readonly options: UploadOptions
    private readonly windowSize: number

    private key = ''
    private uploadId = ''
    private fileId = ''
    private partSize = 0
    private partCount = 0
    private bytesUploaded = 0
    private completedParts: CompletedPart[] = []
    private readonly completedSet = new Set<number>()

    private paused = false
    private cancelled = false
    private finished = false
    private resumeWaiters: Array<() => void> = []
    private readonly localAbort = new AbortController()
    private readonly signal: AbortSignal
    private currentProgress: UploadProgress

    constructor(
        private readonly uploader: ClipMuxUploaderInternals,
        file: UploadSource,
        options: UploadOptions = {},
        resumeState?: ReUploadState,
    ) {
        this.file = file
        this.options = options
        this.windowSize = uploader.windowSize
        this.signal = linkSignals(options.signal, this.localAbort.signal)

        this.filename = resumeState?.filename ?? resolveFilename(file, options.filename)
        this.contentType =
            resumeState?.contentType ?? resolveContentType(file, options.contentType)

        this.currentProgress = {
            percentage: 0,
            bytesUploaded: 0,
            bytesTotal: file.size,
            phase: 'initializing',
            partsCompleted: 0,
            partsTotal: 0,
        }

        if (resumeState) {
            if (resumeState.version !== STATE_VERSION) {
                throw new ClipMuxError(
                    `Unsupported upload state version: ${resumeState.version}`,
                    { code: 'PART_CONFIG_INVALID' },
                )
            }
            if (resumeState.fileSize !== file.size) {
                throw new ClipMuxError(
                    `The file is ${file.size} bytes but the saved upload was for ${resumeState.fileSize} bytes`,
                    { code: 'PART_CONFIG_INVALID' },
                )
            }
            this.key = resumeState.key
            this.uploadId = resumeState.uploadId
            this.fileId = resumeState.fileId
            this.partSize = resumeState.partSize
            this.partCount = resumeState.partCount
            this.bytesUploaded = resumeState.bytesUploaded
            this.completedParts = [...resumeState.completedParts]
            for (const part of this.completedParts) this.completedSet.add(part.part_number)
            this.currentProgress = {
                percentage: this.percent(),
                bytesUploaded: this.bytesUploaded,
                bytesTotal: file.size,
                phase: 'uploading',
                partsCompleted: this.completedParts.length,
                partsTotal: this.partCount,
            }
        }
    }

    /** Video id — available after the create call has resolved. */
    get id(): string {
        return this.fileId
    }

    /** Object key of the original — needed by `abort()`. */
    get objectKey(): string {
        return this.key
    }

    /** Multipart upload id — needed by `abort()`. */
    get multipartUploadId(): string {
        return this.uploadId
    }

    /** Latest progress snapshot. */
    get progress(): UploadProgress {
        return { ...this.currentProgress }
    }

    /**
     * Run (or continue) the upload.
     *
     * Resolves once `/complete` succeeds. Rejects with
     * `UploadAbortedError` after `cancel()`/an aborted signal, or with
     * `ClipMuxError` for anything the API reported.
     */
    async run(): Promise<UploadResult> {
        try {
            await this.execute()
        } catch (error) {
            if (this.signal.aborted && !(error instanceof UploadAbortedError)) {
                throw new UploadAbortedError()
            }
            throw error
        }
        this.finished = true
        return {
            fileId: this.fileId,
            title: this.options.title || this.filename,
            status: 'processing',
            key: this.key,
            uploadId: this.uploadId,
            etag: this.etag,
            bytesUploaded: this.bytesUploaded,
            partCount: this.partCount,
            partSize: this.partSize,
        }
    }

    /** Stop scheduling new parts. In-flight parts are allowed to finish. */
    pause(): void {
        if (this.finished || this.cancelled) return
        this.paused = true
        this.report({ phase: 'paused' })
    }

    /** Continue a paused session. */
    resume(): void {
        if (this.finished || this.cancelled) return
        this.paused = false
        const waiters = this.resumeWaiters
        this.resumeWaiters = []
        for (const wake of waiters) wake()
        if (this.currentProgress.phase === 'paused') this.report({ phase: 'uploading' })
    }

    /**
     * Abort the upload: abandons the multipart upload on the server and
     * deletes the video row. Safe to call more than once, and safe to call
     * after the session finished (it is then a no-op).
     */
    async cancel(): Promise<void> {
        if (this.cancelled) return
        this.cancelled = true
        this.localAbort.abort()
        this.resume()

        // Nothing was created server-side yet — there is nothing to clean up.
        if (!this.key || !this.uploadId) return

        await this.uploader.abortRequest(this.key, this.uploadId, this.fileId || undefined)
    }

    /**
     * The session as plain JSON, for `localStorage` or a database row.
     * Contains no File handle and no presigned URL (they expire).
     */
    toJSON(): ReUploadState {
        return {
            version: STATE_VERSION,
            key: this.key,
            uploadId: this.uploadId,
            fileId: this.fileId,
            partSize: this.partSize,
            partCount: this.partCount,
            filename: this.filename,
            fileSize: this.file.size,
            contentType: this.contentType,
            completedParts: [...this.completedParts],
            bytesUploaded: this.bytesUploaded,
            options: {
                title: this.options.title,
                playbackPolicy: this.options.playbackPolicy,
                generateSubtitle: this.options.generateSubtitle,
                generateChapters: this.options.generateChapters,
            },
        }
    }

    // ───────────────────────────── internals ─────────────────────────────

    private etag: string | undefined

    private percent(): number {
        if (this.file.size <= 0) return 100
        return Math.min(100, Math.round((this.bytesUploaded / this.file.size) * 100))
    }

    private report(patch: Partial<UploadProgress>): void {
        // A part that lands *after* pause() must not flip the phase back to
        // 'uploading' — the session is still parked, it just drained.
        const requested = patch.phase
        const phase =
            this.paused && (requested === undefined || requested === 'uploading')
                ? 'paused'
                : requested

        this.currentProgress = {
            ...this.currentProgress,
            ...patch,
            ...(phase ? { phase } : {}),
            percentage: this.percent(),
            bytesUploaded: this.bytesUploaded,
            bytesTotal: this.file.size,
            partsCompleted: this.completedParts.length,
            partsTotal: this.partCount || this.currentProgress.partsTotal,
        }
        this.options.onProgress?.(this.progress)
    }

    private throwIfAborted(): void {
        if (this.cancelled || this.signal.aborted) throw new UploadAbortedError()
    }

    /** Block while paused, and throw if the session was cancelled meanwhile. */
    private async waitWhilePaused(): Promise<void> {
        this.throwIfAborted()
        while (this.paused && !this.cancelled) {
            await new Promise<void>((resolve) => {
                // Either a resume() or an abort must wake this — and the first
                // one to fire has to remove the other's listener.
                const wakeOnce = () => {
                    this.signal.removeEventListener('abort', wakeOnce)
                    resolve()
                }
                this.resumeWaiters.push(wakeOnce)
                this.signal.addEventListener('abort', wakeOnce, { once: true })
            })
        }
        this.throwIfAborted()
    }

    private async execute(): Promise<void> {
        this.throwIfAborted()
        this.report({ phase: 'initializing' })

        if (!this.uploadId) {
            await this.create()
        }

        this.report({ phase: 'uploading' })

        const plan = computePartPlan(this.file.size, this.partSize)
        const pending = plan.filter((part) => !this.completedSet.has(part.partNumber))

        for (let start = 0; start < pending.length; start += this.windowSize) {
            await this.waitWhilePaused()
            const windowParts = pending.slice(start, start + this.windowSize)
            await this.uploadWindow(windowParts)
        }

        this.report({ phase: 'completing' })
        await this.complete()
        this.report({ phase: 'completing' })
    }

    private async create(): Promise<void> {
        const create = await this.requestJson<CreateUploadResponse>('/v1/upload/create', {
            filename: this.filename,
            content_type: this.contentType,
            size: this.file.size,
            title: this.options.title || this.filename,
            playback_policy: this.options.playbackPolicy || 'public',
            generate_subtitle: this.options.generateSubtitle || false,
            generate_chapters: this.options.generateChapters || false,
        })

        if (
            !Number.isInteger(create.part_size) ||
            create.part_size <= 0 ||
            !Number.isInteger(create.part_count) ||
            create.part_count <= 0
        ) {
            throw new ClipMuxError('Server returned an invalid part configuration', {
                code: 'PART_CONFIG_INVALID',
            })
        }

        this.key = create.key
        this.uploadId = create.upload_id
        this.fileId = create.file_id
        this.partSize = create.part_size
        this.partCount = create.part_count

        // Legacy servers may still pre-mint every URL; record them so the first
        // window does not spend a round trip re-requesting what we already have.
        for (const part of create.urls ?? []) {
            if (
                Number.isInteger(part.part_number) &&
                part.part_number >= 1 &&
                typeof part.url === 'string'
            ) {
                this.preloaded.set(part.part_number, part.url)
            }
        }

        this.report({ phase: 'uploading' })
    }

    private readonly preloaded = new Map<number, string>()

    private async requestParts(partNumbers: number[]): Promise<Map<number, string>> {
        const window = await this.requestJson<PartsWindow>('/v1/upload/parts', {
            key: this.key,
            upload_id: this.uploadId,
            file_id: this.fileId,
            size: this.file.size,
            part_size: this.partSize,
            part_numbers: partNumbers,
        })

        // The server recomputes the plan on every /parts call. If it ever
        // disagreed with the plan this session is slicing, the parts would be
        // the wrong bytes — fail loudly now instead of at /complete.
        if (window.part_size !== this.partSize || window.part_count !== this.partCount) {
            throw new ClipMuxError(
                `Server part plan changed mid-upload (${window.part_size}×${window.part_count} vs ${this.partSize}×${this.partCount})`,
                { code: 'PART_CONFIG_INVALID' },
            )
        }

        const urls = new Map<number, string>()
        for (const part of window.urls) {
            urls.set(part.part_number, part.url)
        }
        return urls
    }

    private async uploadWindow(
        windowParts: { partNumber: number; start: number; end: number }[],
    ): Promise<void> {
        const urlsByNumber = new Map<number, string>()
        for (const part of windowParts) {
            const preloaded = this.preloaded.get(part.partNumber)
            if (preloaded) urlsByNumber.set(part.partNumber, preloaded)
        }

        const fetchWindow = async (): Promise<void> => {
            const fetched = await this.requestParts(windowParts.map((p) => p.partNumber))
            for (const [partNumber, url] of fetched) {
                urlsByNumber.set(partNumber, url)
                this.preloaded.delete(partNumber)
            }
        }

        let fetchedAt = 0
        if (urlsByNumber.size < windowParts.length) {
            await fetchWindow()
            fetchedAt = Date.now()
        }

        const refreshIfStale = async (): Promise<void> => {
            if (this.uploader.presignRefreshMs <= 0 || fetchedAt === 0) return
            if (Date.now() - fetchedAt < this.uploader.presignRefreshMs) return
            await fetchWindow()
            fetchedAt = Date.now()
        }

        const queue = [...windowParts]
        const inFlight = new Set<Promise<void>>()

        const track = (promise: Promise<void>): void => {
            inFlight.add(promise)
            // Attach a handler immediately: a rejection that nothing awaits is
            // an unhandled rejection, and the drain below may rethrow before
            // every promise has been observed.
            void promise.then(
                () => inFlight.delete(promise),
                () => inFlight.delete(promise),
            )
        }

        const uploadPart = async (part: { partNumber: number; start: number; end: number }): Promise<void> => {
            await this.waitWhilePaused()
            this.throwIfAborted()

            const blob = this.file.slice(part.start, part.end)
            let lastError: Error | null = null
            let refreshed = false
            let attempt = 0

            // `while (true)`: the URL-refresh path below retries *without*
            // spending a retry, because re-signing an expired URL is recovery
            // from an expected condition rather than a failed attempt.
            for (;;) {
                try {
                    this.throwIfAborted()

                    const url = urlsByNumber.get(part.partNumber)
                    if (!url) {
                        throw new ClipMuxError(`No presigned URL for part ${part.partNumber}`, {
                            code: 'PART_CONFIG_INVALID',
                        })
                    }

                    const response = await this.uploader.fetchImpl(url, {
                        method: 'PUT',
                        body: blob,
                        signal: this.signal,
                    })

                    if (response.status === 401 || response.status === 403) {
                        // The presigned URL expired or was revoked. Re-fetch the
                        // window once, then retry this part.
                        if (!refreshed) {
                            refreshed = true
                            await fetchWindow()
                            continue
                        }
                        throw new ClipMuxError(
                            `Part ${part.partNumber} rejected (${response.status}) after refreshing its URL`,
                            { code: 'PART_URL_REJECTED', status: response.status },
                        )
                    }

                    if (!response.ok) {
                        throw new ClipMuxError(
                            `Part ${part.partNumber} upload failed: ${response.status}`,
                            {
                                code: 'HTTP',
                                status: response.status,
                                retryable: response.status >= 500,
                            },
                        )
                    }

                    const etag = (response.headers.get('ETag') || '').replace(/"/g, '')
                    urlsByNumber.delete(part.partNumber)
                    this.completedParts.push({ part_number: part.partNumber, etag })
                    this.completedSet.add(part.partNumber)
                    this.bytesUploaded += part.end - part.start
                    this.report({ phase: 'uploading' })
                    return
                } catch (error) {
                    if (error instanceof UploadAbortedError || this.signal.aborted) {
                        throw new UploadAbortedError()
                    }
                    lastError = error instanceof Error ? error : new Error(String(error))
                    if (attempt >= this.uploader.maxRetries) break
                    await this.uploader.backoff(attempt, lastError)
                    attempt++
                    await refreshIfStale()
                }
            }

            throw lastError ||
                new ClipMuxError(`Part ${part.partNumber} failed after retries`, { code: 'HTTP' })
        }

        while (queue.length > 0 || inFlight.size > 0) {
            await this.waitWhilePaused()
            while (queue.length > 0 && inFlight.size < this.uploader.concurrency) {
                track(uploadPart(queue.shift()!))
            }
            if (inFlight.size > 0) {
                try {
                    await Promise.race(inFlight)
                } catch (error) {
                    // Let the rest of this window settle before surfacing the
                    // failure: a part that lands after run() rejected would
                    // otherwise mutate progress the caller already gave up on.
                    await Promise.allSettled([...inFlight])
                    throw error
                }
            }
        }
    }

    private async complete(): Promise<void> {
        const parts = [...this.completedParts].sort((a, b) => a.part_number - b.part_number)

        const complete = await this.requestJson<CompleteUploadResponse>('/v1/upload/complete', {
            key: this.key,
            upload_id: this.uploadId,
            file_id: this.fileId,
            parts,
        })
        this.etag = complete.etag
    }

    /**
     * POST a control-plane request and parse its JSON, retrying only what is
     * safe to retry.
     *
     * Retries are limited to a rate limit (the middleware rejects before any
     * handler runs, so nothing was created) and to transport failures. A 5xx is
     * deliberately *not* retried: `/create` inserts a video row and starts a
     * multipart upload, and a retry after an ambiguous failure can orphan one;
     * `/complete` is equally ambiguous (R2 may have completed the upload before
     * the response was lost). Surfacing the error to the caller, who can inspect
     * and clean up, is the honest failure mode.
     */
    private async requestJson<T>(path: string, body: unknown): Promise<T> {
        let lastError: ClipMuxError | null = null

        for (let attempt = 0; attempt <= this.uploader.maxRetries; attempt++) {
            if (attempt > 0 && lastError) await this.uploader.backoff(attempt - 1, lastError)

            let response: Response
            try {
                response = await this.uploader.jsonRequest(path, body)
            } catch (cause) {
                lastError = new ClipMuxError(`${path} request failed: ${describe(cause)}`, {
                    code: 'NETWORK',
                    retryable: true,
                    cause,
                })
                continue
            }

            if (!response.ok) {
                const serverMessage = await readServerError(response)
                const code = codeForResponse(response.status, serverMessage)
                lastError = new ClipMuxError(serverMessage, {
                    code,
                    status: response.status,
                    requestId: response.headers.get('x-request-id') ?? undefined,
                    retryable: isRetryableCode(code),
                    retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
                })
                if (!lastError.retryable) throw lastError
                continue
            }

            try {
                return (await response.json()) as T
            } catch (cause) {
                throw new ClipMuxError(`${path} returned a non-JSON response`, {
                    code: 'HTTP',
                    status: response.status,
                    cause,
                })
            }
        }

        throw lastError ?? new ClipMuxError(`${path} failed`, { code: 'HTTP' })
    }
}

/** The slice of the uploader a session needs — keeps the two files decoupled. */
export interface ClipMuxUploaderInternals {
    fetchImpl: typeof fetch
    delayImpl: (ms: number) => Promise<void>
    concurrency: number
    maxRetries: number
    windowSize: number
    presignRefreshMs: number
    jsonRequest(path: string, body: unknown): Promise<Response>
    abortRequest(key: string, uploadId: string, fileId?: string): Promise<{ aborted: boolean }>
    backoff(attempt: number, error: unknown): Promise<void>
}

export class ClipMuxUploader implements ClipMuxUploaderInternals {
    readonly fetchImpl: typeof fetch
    readonly delayImpl: (ms: number) => Promise<void>
    readonly concurrency: number
    readonly maxRetries: number
    readonly windowSize: number
    readonly presignRefreshMs: number

    private readonly baseUrl: string
    private readonly uploadToken: string
    private readonly retryDelay: number

    constructor(config: ClipMuxUploaderConfig) {
        if (!config.baseUrl) throw new ClipMuxError('baseUrl is required', { code: 'HTTP' })
        if (!config.uploadToken) {
            throw new ClipMuxError('uploadToken is required', { code: 'UPLOAD_TOKEN_INVALID' })
        }

        this.baseUrl = config.baseUrl.replace(/\/+$/, '') // strip trailing slashes
        this.uploadToken = config.uploadToken
        this.concurrency = Math.max(1, config.concurrency ?? 3)
        this.maxRetries = Math.max(0, config.maxRetries ?? 3)
        this.retryDelay = config.retryDelay ?? 1000
        this.windowSize = Math.min(
            MAX_WINDOW_SIZE,
            Math.max(1, Math.floor(config.windowSize ?? DEFAULT_WINDOW_SIZE)),
        )
        this.presignRefreshMs = config.presignRefreshMs ?? DEFAULT_PRESIGN_REFRESH_MS
        this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args))
        this.delayImpl = config.delayImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    }

    /**
     * Upload a file in one call.
     *
     * For progress-with-pause or a resumable upload, use `startUpload()`.
     */
    async upload(file: UploadSource, options: UploadOptions = {}): Promise<UploadResult> {
        return this.startUpload(file, options).run()
    }

    /** Start a controllable, resumable upload session. */
    startUpload(file: UploadSource, options: UploadOptions = {}): UploadSession {
        return new UploadSession(this, file, options)
    }

    /**
     * Continue an upload from `session.toJSON()`.
     *
     * The `file` must be the same bytes (its size is checked) — a `File` handle
     * cannot be serialized, so the caller re-supplies it after a reload.
     */
    resumeUpload(state: ReUploadState, file: UploadSource, options: UploadOptions = {}): UploadSession {
        const merged: UploadOptions = {
            ...state.options,
            ...options,
            // Options carried in the state are defaults; anything passed here wins.
        }
        return new UploadSession(this, file, merged, state)
    }

    /**
     * Abandon a multipart upload that will never be completed.
     *
     * Deletes the abandoned parts (they are billed until deleted) and the video
     * row. `key`/`uploadId` come from `UploadResult` or `session.toJSON()`.
     */
    async abort(key: string, uploadId: string, fileId?: string): Promise<{ aborted: boolean }> {
        return this.abortRequest(key, uploadId, fileId)
    }

    // ───────────────────── ClipMuxUploaderInternals ─────────────────────

    async abortRequest(
        key: string,
        uploadId: string,
        fileId?: string,
    ): Promise<{ aborted: boolean }> {
        const response = await this.jsonRequest('/v1/upload/abort', {
            key,
            upload_id: uploadId,
            file_id: fileId,
        })
        if (!response.ok) {
            const serverMessage = await readServerError(response)
            const code = codeForResponse(response.status, serverMessage)
            throw new ClipMuxError(serverMessage, { code, status: response.status })
        }
        return (await response.json()) as { aborted: boolean }
    }

    async jsonRequest(path: string, body: unknown): Promise<Response> {
        return this.fetchImpl(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `UploadToken ${this.uploadToken}`,
            },
            body: JSON.stringify(body),
        })
    }

    /**
     * Wait before the next attempt of `error`.
     *
     * Honours `Retry-After` when the API set one (the rate limiter always
     * does), otherwise uses exponential backoff. Jitter keeps a fleet of
     * clients retrying the same rate-limited window from re-colliding.
     */
    async backoff(attempt: number, error: unknown): Promise<void> {
        let delayMs = this.retryDelay * 2 ** attempt

        if (error instanceof ClipMuxError && error.retryAfterMs !== undefined) {
            delayMs = error.retryAfterMs
        } else if (error instanceof ClipMuxError && isRetryableCode(error.code)) {
            delayMs += Math.floor(Math.random() * this.retryDelay)
        }

        await this.delayImpl(Math.max(0, delayMs))
    }
}
