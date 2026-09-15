/**
 * Webhook verification.
 *
 * The contract, from `server/src/utils/webhookDispatcher.ts`:
 *
 *   X-Webhook-Signature: sha256=<hex hmac-sha256(secret, `${timestamp}.${rawBody}`)>
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Event:     <event name>
 *   X-Webhook-Id:        <evt_…>
 *
 * Two details decide whether verification works at all:
 *
 *  1. **Verify against the raw body.** Most frameworks parse JSON before your
 *     handler runs. Re-serializing the parsed object (`JSON.stringify(req.body)`)
 *     does not reproduce the bytes that were signed — key order, whitespace and
 *     number formatting are all free to differ — so the digest never matches.
 *     Every function here takes `rawBody: string | Uint8Array`.
 *  2. **Compare in constant time.** A byte-by-byte `===` leaks how much of a
 *     forged signature was correct. `crypto.subtle.verify` is used rather than a
 *     hand-rolled loop, and it also keeps this module free of `node:crypto` so
 *     it runs on Workers and edge runtimes too.
 */

import { WebhookSignatureError } from './errors'
import type { WebhookEventPayload } from './types'

/** Every event the API can deliver. */
export const WEBHOOK_EVENTS = [
    'video.uploading',
    'video.uploaded',
    'video.processing',
    'video.ready',
    'video.failed',
    'video.updated',
    'video.deleted',
    'subtitle.generating',
    'subtitle.generated',
    'subtitle.failed',
    'chapters.generating',
    'chapters.generated',
    'chapters.failed',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/**
 * Events delivered through the transactional outbox (retried until delivered).
 *
 * Everything else dispatches directly — once, with no retry — so a receiver
 * must not assume at-least-once delivery for those.
 */
export const RELIABLE_WEBHOOK_EVENTS: readonly WebhookEvent[] = ['video.ready', 'video.failed']

/** How far the timestamp may be from now, in seconds, by default. */
export const DEFAULT_TOLERANCE_SECONDS = 300

export interface VerifyWebhookOptions {
    /** The endpoint's `whsec_…` signing secret. */
    secret: string
    /** The request body, exactly as received. */
    rawBody: string | Uint8Array
    /** `X-Webhook-Signature` — `sha256=<hex>` or bare `<hex>`. */
    signature?: string | null
    /** `X-Webhook-Timestamp` — unix seconds. */
    timestamp?: string | number | null
    /** Replay window in seconds (default 300). `0` disables the check. */
    toleranceSeconds?: number
    /** Injectable clock, for tests. Epoch ms. */
    nowMs?: number
}

export interface WebhookVerification {
    /** The verified timestamp, as epoch seconds. */
    timestamp: number
}

/**
 * Verify a webhook signature, throwing `WebhookSignatureError` when it is not
 * trustworthy.
 *
 * Throwing (rather than returning a boolean) is what stops the common bug of
 * forgetting to check the return value.
 */
export async function verifyWebhookSignature(options: VerifyWebhookOptions): Promise<WebhookVerification> {
    const { secret, rawBody, signature, timestamp } = options

    if (!secret) {
        throw new WebhookSignatureError('missing_header', 'A webhook signing secret is required')
    }

    if (!signature) {
        throw new WebhookSignatureError(
            'missing_header',
            'Missing X-Webhook-Signature header',
        )
    }
    if (timestamp === undefined || timestamp === null || timestamp === '') {
        throw new WebhookSignatureError(
            'missing_header',
            'Missing X-Webhook-Timestamp header',
        )
    }

    const timestampSeconds = parseTimestamp(timestamp)
    const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
    if (toleranceSeconds > 0) {
        const nowMs = options.nowMs ?? Date.now()
        const skewMs = Math.abs(nowMs - timestampSeconds * 1000)
        if (skewMs > toleranceSeconds * 1000) {
            throw new WebhookSignatureError(
                'stale',
                `Webhook timestamp is ${Math.round(skewMs / 1000)}s outside the ${toleranceSeconds}s tolerance — ` +
                    'this is either a replay or a clock that disagrees with the sender',
                skewMs,
            )
        }
    }

    const provided = parseSignature(signature)
    // Copied into a fresh ArrayBuffer: `Uint8Array<ArrayBufferLike>` may be a
    // view over a SharedArrayBuffer, which WebCrypto will not accept.
    const body =
        typeof rawBody === 'string'
            ? new TextEncoder().encode(rawBody)
            : new Uint8Array(rawBody)
    // Sign the header value as sent, not a re-formatted number: the sender's
    // string is part of what was signed.
    const timestampString = typeof timestamp === 'string' ? timestamp.trim() : String(timestamp)
    const signedPayload = concat(new TextEncoder().encode(`${timestampString}.`), body)

    const key = await importHmacKey(secret)
    // `subtle.verify` compares in constant time; a hand-rolled loop that
    // short-circuits would leak how much of a forged signature was correct.
    const matches = await crypto.subtle.verify('HMAC', key, hexToBytes(provided), signedPayload)

    if (!matches) {
        throw new WebhookSignatureError(
            'mismatch',
            'Webhook signature does not match. Verify against the raw request body — ' +
                're-serializing parsed JSON changes the bytes that were signed.',
        )
    }

    return { timestamp: timestampSeconds }
}

/** Non-throwing form of `verifyWebhookSignature`. */
export async function checkWebhookSignature(
    options: VerifyWebhookOptions,
): Promise<{ ok: true; timestamp: number } | { ok: false; error: WebhookSignatureError }> {
    try {
        const result = await verifyWebhookSignature(options)
        return { ok: true, timestamp: result.timestamp }
    } catch (error) {
        if (error instanceof WebhookSignatureError) return { ok: false, error }
        throw error
    }
}

export interface ConstructEventOptions extends VerifyWebhookOptions {
    /** `X-Webhook-Event`, used only as a cross-check against the payload. */
    event?: string | null
}

/**
 * Verify **and** parse a webhook in one call — the usual thing a route wants.
 *
 * ```ts
 * const event = await constructWebhookEvent({
 *   secret: process.env.CLIPMUX_WEBHOOK_SECRET!,
 *   rawBody: await req.text(),
 *   signature: req.headers.get('x-webhook-signature'),
 *   timestamp: req.headers.get('x-webhook-timestamp'),
 * })
 *
 * if (event.event === 'video.ready') await markReady(event.data.videoId)
 * ```
 */
export async function constructWebhookEvent<T = Record<string, unknown>>(
    options: ConstructEventOptions,
): Promise<WebhookEventPayload<T>> {
    await verifyWebhookSignature(options)

    const payload = parseWebhookEvent<T>(options.rawBody)

    // The header and the payload must agree; a mismatch means something between
    // the sender and here rewrote one of them.
    if (options.event && options.event !== payload.event) {
        throw new WebhookSignatureError(
            'mismatch',
            `X-Webhook-Event (${options.event}) does not match the payload's event (${payload.event})`,
        )
    }

    return payload
}

/**
 * Parse a delivery **without** verifying it.
 *
 * Named to be conspicuous at the call site: this is only appropriate when the
 * signature was already checked (or when reading a stored delivery).
 */
export function parseWebhookEvent<T = Record<string, unknown>>(
    rawBody: string | Uint8Array,
): WebhookEventPayload<T> {
    const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody)

    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (cause) {
        throw new WebhookSignatureError(
            'malformed',
            `Webhook body is not valid JSON: ${(cause as Error).message}`,
        )
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new WebhookSignatureError('malformed', 'Webhook body is not a JSON object')
    }

    const record = parsed as Partial<WebhookEventPayload<T>>
    if (typeof record.event !== 'string' || !record.event) {
        throw new WebhookSignatureError('malformed', 'Webhook payload has no event name')
    }

    return {
        id: typeof record.id === 'string' ? record.id : '',
        event: record.event,
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
        data: (record.data ?? {}) as T,
    }
}

/** True when the event name is one this API can send. */
export function isWebhookEvent(value: string): value is WebhookEvent {
    return (WEBHOOK_EVENTS as readonly string[]).includes(value)
}

// ───────────────────────────── internals ─────────────────────────────

function parseTimestamp(timestamp: string | number): number {
    const seconds = typeof timestamp === 'number' ? timestamp : Number(timestamp.trim())
    if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
        throw new WebhookSignatureError(
            'invalid_timestamp',
            `X-Webhook-Timestamp must be an integer number of seconds, got "${timestamp}"`,
        )
    }
    return seconds
}

/** Accept `sha256=<hex>` and bare `<hex>`. */
function parseSignature(signature: string): string {
    const match = signature.trim().match(/^(?:sha256=)?([0-9a-fA-F]{64})$/)
    if (!match) {
        throw new WebhookSignatureError(
            'malformed',
            'X-Webhook-Signature must be 64 hex characters, optionally prefixed with "sha256="',
        )
    }
    return match[1].toLowerCase()
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
    )
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(hex.length / 2)
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    }
    return bytes
}

function concat(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
}
