/**
 * Errors raised by the ClipMux server SDK.
 *
 * Two families live here because they fail in different places:
 *
 *  - `ClipMuxError` — an API call failed. Carries the HTTP status, the API's
 *    message, and the request id, so a caller can branch on `code` instead of
 *    parsing prose.
 *  - `WebhookSignatureError` — an inbound webhook could not be trusted. This is
 *    a security decision, so it always reasons explicitly and never fails open.
 */

export type ClipMuxErrorCode =
    /** Missing, malformed, or unknown API key. */
    | 'UNAUTHORIZED'
    /** The key is valid but this resource belongs to another organization. */
    | 'FORBIDDEN'
    /** No such video (or it is soft-deleted). */
    | 'NOT_FOUND'
    /** The request was rejected — bad field, bad expiration, bad size. */
    | 'INVALID_REQUEST'
    /** The video exists but is not ready for playback yet. */
    | 'VIDEO_NOT_READY'
    /** Rate limited. Retry after `retryAfterMs`. */
    | 'RATE_LIMITED'
    /** `fetch` failed before any response arrived. Retryable. */
    | 'NETWORK'
    /** The request timed out. Retryable. */
    | 'TIMEOUT'
    /** 5xx from the API. Retryable. */
    | 'SERVER_ERROR'
    /** Any other non-2xx. */
    | 'HTTP'

export interface ClipMuxErrorOptions {
    code: ClipMuxErrorCode
    status?: number
    requestId?: string
    retryable?: boolean
    retryAfterMs?: number
    cause?: unknown
}

export class ClipMuxError extends Error {
    override readonly name = 'ClipMuxError'
    readonly code: ClipMuxErrorCode
    readonly status?: number
    readonly requestId?: string
    readonly retryable: boolean
    readonly retryAfterMs?: number

    constructor(message: string, options: ClipMuxErrorOptions) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
        this.code = options.code
        this.status = options.status
        this.requestId = options.requestId
        this.retryable = options.retryable ?? false
        this.retryAfterMs = options.retryAfterMs
    }
}

/** Why a webhook signature was rejected. */
export type WebhookSignatureFailure =
    /** The signature or timestamp header is absent. */
    | 'missing_header'
    /** The signature header is not `sha256=<hex>` (or bare hex). */
    | 'malformed'
    /** The timestamp header is not an integer number of seconds. */
    | 'invalid_timestamp'
    /** The timestamp is outside the tolerance window — a possible replay. */
    | 'stale'
    /** The digest does not match the body. */
    | 'mismatch'

export class WebhookSignatureError extends Error {
    override readonly name = 'WebhookSignatureError'
    readonly reason: WebhookSignatureFailure
    /** How far outside the tolerance window the timestamp was, in ms. */
    readonly skewMs?: number

    constructor(reason: WebhookSignatureFailure, message: string, skewMs?: number) {
        super(message)
        this.reason = reason
        this.skewMs = skewMs
    }
}

/** Map an HTTP status (and the API's message) onto a code. */
export function codeForStatus(status: number, message: string): ClipMuxErrorCode {
    if (status === 401) return 'UNAUTHORIZED'
    if (status === 403) return 'FORBIDDEN'
    if (status === 404) return 'NOT_FOUND'
    if (status === 429) return 'RATE_LIMITED'
    if (status === 400 || status === 409 || status === 422) {
        // Playback before transcoding finished is a distinct, expected state:
        // the caller should wait and retry, not fix the request.
        if (/not ready for playback/i.test(message)) return 'VIDEO_NOT_READY'
        return 'INVALID_REQUEST'
    }
    if (status >= 500) return 'SERVER_ERROR'
    return 'HTTP'
}

/** Codes where retrying the same request can succeed. */
export function isRetryableCode(code: ClipMuxErrorCode): boolean {
    return code === 'RATE_LIMITED' || code === 'NETWORK' || code === 'TIMEOUT' ||
        code === 'SERVER_ERROR'
}

/** `Retry-After` (delta-seconds or HTTP date) → ms from now. */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | undefined {
    if (!header) return undefined
    const trimmed = header.trim()
    if (!trimmed) return undefined
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
    const date = Date.parse(trimmed)
    if (Number.isNaN(date)) return undefined
    return Math.max(0, date - nowMs)
}
