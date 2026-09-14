/**
 * Typed errors for the OpenVOD upload SDK.
 *
 * Before this existed every failure was a bare `Error` carrying the server's
 * prose, so callers had to `if (err.message.includes('expired'))` to tell a
 * lapsed upload token (re-mint it and retry) from a size mismatch (the bytes
 * are wrong; retrying will not help) from a rate limit (wait, then retry).
 * The codes below are the ones the public API can actually return — see
 * `server/src/routes/upload-public.ts` and `server/src/middleware/uploadToken.ts`.
 */

export type OpenVodErrorCode =
    /** The upload token expired (only enforced on `/create`). Mint a new one. */
    | 'UPLOAD_TOKEN_EXPIRED'
    /** The token's `max_files` budget is spent. Mint a new one. */
    | 'UPLOAD_TOKEN_EXHAUSTED'
    /** Missing/unknown token, or a malformed `Authorization` header. */
    | 'UPLOAD_TOKEN_INVALID'
    /** The installation turned uploads off (`UPLOADS_ENABLED=false`). */
    | 'UPLOADS_DISABLED'
    /** The completed object's size does not match the declared size. */
    | 'SIZE_MISMATCH'
    /** The object never landed in storage. */
    | 'OBJECT_MISSING'
    /** 429 from the API rate limiter. Retryable after `retryAfterMs`. */
    | 'RATE_LIMITED'
    /** The size needs more than the API's 10 000-part ceiling. */
    | 'TOO_MANY_PARTS'
    /** A presigned part URL was rejected even after a refresh. */
    | 'PART_URL_REJECTED'
    /** The server returned a part plan this client cannot follow. */
    | 'PART_CONFIG_INVALID'
    /** `fetch` itself failed (no HTTP response). Retryable. */
    | 'NETWORK'
    /** Any other non-2xx response. */
    | 'HTTP'

export interface OpenVodErrorOptions {
    code: OpenVodErrorCode
    /** HTTP status, when there was a response. */
    status?: number
    /** `x-request-id` echoed by the API — quote it in support requests. */
    requestId?: string
    /** Whether retrying the same operation can plausibly succeed. */
    retryable?: boolean
    /** `Retry-After` in ms, when the server sent one. */
    retryAfterMs?: number
    cause?: unknown
}

/** Every failure raised by this SDK — HTTP, protocol, or transport. */
export class OpenVodError extends Error {
    override readonly name = 'OpenVodError'
    readonly code: OpenVodErrorCode
    readonly status?: number
    readonly requestId?: string
    readonly retryable: boolean
    readonly retryAfterMs?: number

    constructor(message: string, options: OpenVodErrorOptions) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
        this.code = options.code
        this.status = options.status
        this.requestId = options.requestId
        this.retryable = options.retryable ?? false
        this.retryAfterMs = options.retryAfterMs
    }
}

/**
 * Raised when the caller aborts — via the `signal` option or `cancel()`.
 *
 * Distinct from the other failures because aborting is a normal outcome, not
 * an error: it should not be reported to error trackers or retried.
 */
export class UploadAbortedError extends Error {
    override readonly name = 'UploadAbortedError'
    constructor(message = 'Upload aborted') {
        super(message)
    }
}

/** True when a value is the SDK's own abort signal. */
export function isUploadAbortedError(value: unknown): value is UploadAbortedError {
    return value instanceof UploadAbortedError
}

type ServerErrorBody = { error?: unknown; hint?: unknown }

/**
 * Map a non-2xx API response onto a code.
 *
 * The message string is the only signal the API gives for most 4xx cases
 * (there is no machine-readable `code` field), so the mapping reads it. The
 * alternative — matching on status alone — cannot separate "token expired"
 * from "token exhausted", and both messages are stable strings in the server.
 */
export function codeForResponse(status: number, serverMessage: string): OpenVodErrorCode {
    const message = serverMessage.toLowerCase()

    if (status === 429) return 'RATE_LIMITED'

    if (status === 401 || status === 403) {
        if (message.includes('expired')) return 'UPLOAD_TOKEN_EXPIRED'
        if (message.includes('fully used')) return 'UPLOAD_TOKEN_EXHAUSTED'
        if (message.includes('disabled')) return 'UPLOADS_DISABLED'
        return 'UPLOAD_TOKEN_INVALID'
    }

    if (message.includes('size does not match')) return 'SIZE_MISMATCH'
    if (message.includes('not been uploaded') || message.includes('not uploaded')) {
        return 'OBJECT_MISSING'
    }
    if (message.includes('too many parts')) return 'TOO_MANY_PARTS'

    return 'HTTP'
}

/** Codes where retrying the same request can succeed. */
export function isRetryableCode(code: OpenVodErrorCode): boolean {
    return code === 'RATE_LIMITED' || code === 'NETWORK'
}

/** Parse `Retry-After` (delta-seconds or an HTTP date) into ms from now. */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | undefined {
    if (!header) return undefined

    const trimmed = header.trim()
    if (!trimmed) return undefined

    // A bare number is delta-seconds.
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed) * 1000
    }

    const date = Date.parse(trimmed)
    if (Number.isNaN(date)) return undefined
    return Math.max(0, date - nowMs)
}

/** Extract the server's `{ error }` message, if the body is JSON with one. */
export async function readServerError(response: Response): Promise<string> {
    try {
        const data = (await response.json()) as ServerErrorBody
        if (data && typeof data.error === 'string' && data.error.trim()) {
            return data.error
        }
    } catch {
        // Non-JSON body (a gateway HTML page, an empty 502, ...) — fall through.
    }
    return `${response.status} ${response.statusText}`.trim()
}
