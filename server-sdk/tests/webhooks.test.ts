import { describe, expect, it } from 'vitest'
import {
    DEFAULT_TOLERANCE_SECONDS,
    RELIABLE_WEBHOOK_EVENTS,
    WEBHOOK_EVENTS,
    checkWebhookSignature,
    constructWebhookEvent,
    isWebhookEvent,
    parseWebhookEvent,
    verifyWebhookSignature,
} from '../src/webhooks'
import { WebhookSignatureError } from '../src/errors'

/**
 * A real delivery, byte for byte.
 *
 * BODY is exactly what `server/src/utils/webhookDispatcher.ts` stringifies,
 * and SIGNATURE is `HMAC-SHA256(secret, `${TIMESTAMP}.${BODY}`)` computed from
 * those literals — not re-derived through the code under test. If the SDK's
 * definition of "what was signed" drifts from the dispatcher's, this fails.
 */
const SECRET = 'whsec_test_secret'
const TIMESTAMP = 1_700_000_000
const NOW_MS = TIMESTAMP * 1000
const BODY =
    '{"id":"evt_1","event":"video.ready","timestamp":"2023-11-14T22:13:20.000Z","data":{"videoId":"vid_1","hlsUrl":"https://media.example.com/videos/vid_1/playlist.m3u8","duration":612.5}}'
const SIGNATURE = '506830cba8f71925d2d3834bd54af39e00d6463e81db5aee6fa36e53840fa663'

function verify(overrides: Record<string, unknown> = {}) {
    return verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signature: `sha256=${SIGNATURE}`,
        timestamp: String(TIMESTAMP),
        nowMs: NOW_MS,
        ...overrides,
    })
}

describe('verifyWebhookSignature', () => {
    it('accepts a real delivery', async () => {
        await expect(verify()).resolves.toEqual({ timestamp: TIMESTAMP })
    })

    it('accepts a bare hex signature and a numeric timestamp header', async () => {
        await expect(verify({ signature: SIGNATURE, timestamp: TIMESTAMP })).resolves.toEqual({
            timestamp: TIMESTAMP,
        })
    })

    it('rejects a body that does not match the signature', async () => {
        const tampered = BODY.replace('"videoId":"vid_1"', '"videoId":"vid_2"')

        await expect(verify({ rawBody: tampered })).rejects.toMatchObject({
            name: 'WebhookSignatureError',
            reason: 'mismatch',
        })
    })

    it('rejects a re-serialized body — the documented footgun', async () => {
        // `JSON.stringify(JSON.parse(body))` drops nothing here, but the point
        // stands for any body where key order or spacing differs. This case
        // pins the rule: verify the bytes, never a re-serialization.
        const reserialized = JSON.stringify(JSON.parse(BODY), null, 2)

        await expect(verify({ rawBody: reserialized })).rejects.toMatchObject({ reason: 'mismatch' })
    })

    it('rejects a signature over a different timestamp', async () => {
        await expect(verify({ timestamp: String(TIMESTAMP + 60) })).rejects.toMatchObject({
            reason: 'mismatch',
        })
    })

    it('rejects a stale timestamp as a possible replay', async () => {
        await expect(
            verify({ nowMs: NOW_MS + (DEFAULT_TOLERANCE_SECONDS + 1) * 1000 }),
        ).rejects.toMatchObject({ reason: 'stale' })
    })

    it('rejects a timestamp from the future beyond tolerance', async () => {
        await expect(
            verify({ nowMs: NOW_MS - (DEFAULT_TOLERANCE_SECONDS + 1) * 1000 }),
        ).rejects.toMatchObject({ reason: 'stale' })
    })

    it('accepts a timestamp inside the tolerance window', async () => {
        await expect(
            verify({ nowMs: NOW_MS + (DEFAULT_TOLERANCE_SECONDS - 1) * 1000 }),
        ).resolves.toEqual({ timestamp: TIMESTAMP })
    })

    it('can disable the replay window explicitly', async () => {
        await expect(
            verify({ nowMs: NOW_MS + 86_400_000, toleranceSeconds: 0 }),
        ).resolves.toEqual({ timestamp: TIMESTAMP })
    })

    it('reports a missing signature header', async () => {
        await expect(verify({ signature: undefined })).rejects.toMatchObject({
            reason: 'missing_header',
        })
    })

    it('reports a missing timestamp header', async () => {
        await expect(verify({ timestamp: undefined })).rejects.toMatchObject({
            reason: 'missing_header',
        })
    })

    it('reports a malformed signature header', async () => {
        await expect(verify({ signature: 'sha256=nope' })).rejects.toMatchObject({
            reason: 'malformed',
        })
    })

    it('reports a non-numeric timestamp', async () => {
        await expect(verify({ timestamp: 'yesterday' })).rejects.toMatchObject({
            reason: 'invalid_timestamp',
        })
    })

    it('accepts a Uint8Array body', async () => {
        const bytes = new TextEncoder().encode(BODY)

        await expect(verify({ rawBody: bytes })).resolves.toEqual({ timestamp: TIMESTAMP })
    })

    it('refuses to verify without a secret', async () => {
        await expect(verify({ secret: '' })).rejects.toBeInstanceOf(WebhookSignatureError)
    })
})

describe('checkWebhookSignature', () => {
    it('returns a failure instead of throwing', async () => {
        const result = await checkWebhookSignature({
            secret: SECRET,
            rawBody: BODY,
            signature: `sha256=${'0'.repeat(64)}`,
            timestamp: String(TIMESTAMP),
            nowMs: NOW_MS,
        })

        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBeInstanceOf(WebhookSignatureError)
    })

    it('returns the timestamp on success', async () => {
        const result = await checkWebhookSignature({
            secret: SECRET,
            rawBody: BODY,
            signature: `sha256=${SIGNATURE}`,
            timestamp: String(TIMESTAMP),
            nowMs: NOW_MS,
        })

        expect(result).toEqual({ ok: true, timestamp: TIMESTAMP })
    })
})

describe('constructWebhookEvent', () => {
    it('verifies and parses a delivery', async () => {
        const event = await constructWebhookEvent({
            secret: SECRET,
            rawBody: BODY,
            signature: `sha256=${SIGNATURE}`,
            timestamp: String(TIMESTAMP),
            nowMs: NOW_MS,
        })

        expect(event.id).toBe('evt_1')
        expect(event.event).toBe('video.ready')
        expect(event.timestamp).toBe('2023-11-14T22:13:20.000Z')
        expect(event.data).toMatchObject({ videoId: 'vid_1', duration: 612.5 })
    })

    it('rejects when the event header disagrees with the payload', async () => {
        await expect(
            constructWebhookEvent({
                secret: SECRET,
                rawBody: BODY,
                signature: `sha256=${SIGNATURE}`,
                timestamp: String(TIMESTAMP),
                nowMs: NOW_MS,
                event: 'video.failed',
            }),
        ).rejects.toMatchObject({ reason: 'mismatch' })
    })

    it('never parses before verifying', async () => {
        await expect(
            constructWebhookEvent({
                secret: SECRET,
                rawBody: '{ not json',
                signature: undefined,
                timestamp: String(TIMESTAMP),
            }),
        ).rejects.toMatchObject({ reason: 'missing_header' })
    })
})

describe('parseWebhookEvent', () => {
    it('parses a stored delivery', () => {
        expect(parseWebhookEvent(BODY).event).toBe('video.ready')
    })

    it('rejects a non-JSON body', () => {
        expect(() => parseWebhookEvent('not json')).toThrowError(/not valid JSON/)
    })

    it('rejects a payload with no event name', () => {
        expect(() => parseWebhookEvent('{"id":"evt_1"}')).toThrowError(/no event name/)
    })
})

describe('event catalogue', () => {
    it('includes the events the API dispatches', () => {
        expect(WEBHOOK_EVENTS).toContain('video.ready')
        expect(WEBHOOK_EVENTS).toContain('chapters.generated')
        expect(isWebhookEvent('video.ready')).toBe(true)
        expect(isWebhookEvent('video.exploded')).toBe(false)
    })

    it('marks only the outbox-delivered events as reliable', () => {
        expect(RELIABLE_WEBHOOK_EVENTS).toEqual(['video.ready', 'video.failed'])
    })
})
