import { describe, expect, it } from 'vitest'
import { OpenVod } from '../src/client'
import { OpenVodError } from '../src/errors'

interface Recorded {
    url: string
    method: string
    headers: Record<string, string>
    body: unknown
}

/**
 * Fake API: records every request and replays canned responses, so the tests
 * assert on the exact HTTP the SDK emits (paths, bodies, auth) rather than on
 * SDK internals.
 */
function makeApi(handlers: Array<{ match: string; status?: number; body?: unknown; headers?: Record<string, string>; times?: number }>) {
    const calls: Recorded[] = []
    const queue = handlers.map((h) => ({ ...h, remaining: h.times ?? Number.POSITIVE_INFINITY }))

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
            headers[key.toLowerCase()] = value
        }
        calls.push({
            url: String(url),
            method: init?.method ?? 'GET',
            headers,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })

        const handler = queue.find(
            (h) => String(url).includes(h.match) && h.remaining > 0,
        )
        if (!handler) return new Response('not found', { status: 404 })

        handler.remaining -= 1
        return Response.json(handler.body ?? {}, {
            status: handler.status ?? 200,
            headers: handler.headers,
        })
    }) as unknown as typeof fetch

    return { fetchImpl, calls }
}

const BASE = 'https://api.example.com'

function makeClient(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
    return new OpenVod({
        apiKey: 'sk_live_test',
        baseUrl: BASE,
        fetchImpl,
        maxRetries: 0,
        ...overrides,
    })
}

describe('OpenVod client', () => {
    it('requires an api key and a base url', () => {
        expect(() => new OpenVod({ apiKey: '', baseUrl: BASE })).toThrowError(/apiKey is required/)
        expect(() => new OpenVod({ apiKey: 'sk_live_x', baseUrl: '' })).toThrowError(
            /baseUrl is required/,
        )
    })

    it('normalizes a trailing slash on the base url', async () => {
        const { fetchImpl, calls } = makeApi([{ match: '/v1/videos', body: { data: [] } }])
        const vod = makeClient(fetchImpl, { baseUrl: 'https://api.example.com/' })

        await vod.videos.list()

        expect(calls[0].url).toBe('https://api.example.com/v1/videos')
    })
})

describe('uploads.createToken', () => {
    it('posts an upload token request with non-default options', async () => {
        const { fetchImpl, calls } = makeApi([
            {
                match: '/v1/upload/token',
                body: {
                    upload_token: 'ut_abc_123',
                    expires_at: '2024-01-01T01:00:00.000Z',
                    max_files: 2,
                    max_size_bytes: 1024,
                },
            },
        ])

        const token = await makeClient(fetchImpl).uploads.createToken({
            expiresIn: '1h',
            maxFiles: 2,
            maxSizeBytes: 1024,
        })

        expect(calls[0].method).toBe('POST')
        expect(calls[0].url).toBe(`${BASE}/v1/upload/token`)
        expect(calls[0].headers.authorization).toBe('Bearer sk_live_test')
        expect(calls[0].body).toEqual({ expires_in: '1h', max_files: 2, max_size_bytes: 1024 })
        expect(token.upload_token).toBe('ut_abc_123')
    })

    it('sends an empty body when no options are given', async () => {
        const { fetchImpl, calls } = makeApi([
            { match: '/v1/upload/token', body: { upload_token: 'ut_x' } },
        ])

        await makeClient(fetchImpl).uploads.createToken()

        expect(calls[0].body).toEqual({})
    })
})

describe('playback.createToken', () => {
    it('forwards viewer binding and restrictions', async () => {
        const { fetchImpl, calls } = makeApi([
            {
                match: '/playback-token',
                body: {
                    playback_url: 'https://media.example.com/videos/v1/playlist.m3u8?token=eyJ',
                    token: 'eyJ',
                    expires_at: 1_700_000_000,
                    playback_policy: 'signed',
                    subtitle_url: null,
                    chapters: null,
                },
            },
        ])

        const session = await makeClient(fetchImpl).playback.createToken('vid_1', {
            expiresIn: '2h',
            viewerUserAgent: 'Mozilla/5.0',
            allowedDomains: ['*.example.com'],
            allowNoReferrer: false,
        })

        expect(calls[0].url).toBe(`${BASE}/v1/video/vid_1/playback-token`)
        expect(calls[0].body).toEqual({
            expires_in: '2h',
            viewer_user_agent: 'Mozilla/5.0',
            allowed_domains: ['*.example.com'],
            allow_no_referrer: false,
        })
        expect(session.token).toBe('eyJ')
        expect(session.playback_policy).toBe('signed')
    })

    it('returns a public video session without a token', async () => {
        const { fetchImpl } = makeApi([
            {
                match: '/playback-token',
                body: {
                    playback_url: 'https://media.example.com/videos/v1/playlist.m3u8',
                    token: null,
                    expires_at: null,
                    playback_policy: 'public',
                    subtitle_url: null,
                    chapters: null,
                },
            },
        ])

        const session = await makeClient(fetchImpl).playback.createToken('vid_1')

        expect(session.token).toBeNull()
        expect(session.playback_url).toContain('playlist.m3u8')
    })

    it('surfaces "not ready" as its own code', async () => {
        const { fetchImpl } = makeApi([
            {
                match: '/playback-token',
                status: 400,
                body: { error: 'Video not ready for playback', status: 'processing' },
            },
        ])

        await expect(makeClient(fetchImpl).playback.createToken('vid_1')).rejects.toMatchObject({
            code: 'VIDEO_NOT_READY',
            status: 400,
            retryable: false,
        })
    })
})

describe('videos', () => {
    it('gets one video', async () => {
        const { fetchImpl, calls } = makeApi([
            {
                match: '/v1/video/vid_1',
                body: {
                    id: 'vid_1',
                    title: 'Clip',
                    status: 'ready',
                    playback_policy: 'public',
                    duration: 12,
                    thumbnail_url: null,
                    created_at: '2024-01-01T00:00:00.000Z',
                },
            },
        ])

        const video = await makeClient(fetchImpl).videos.get('vid_1')

        expect(calls[0].method).toBe('GET')
        expect(video.status).toBe('ready')
    })

    it('url-encodes an id', async () => {
        const { fetchImpl, calls } = makeApi([{ match: '/v1/video/', body: { id: 'a b' } }])

        await makeClient(fetchImpl).videos.get('a b')

        expect(calls[0].url).toBe(`${BASE}/v1/video/a%20b`)
    })

    it('lists videos with filters in the query string', async () => {
        const { fetchImpl, calls } = makeApi([{ match: '/v1/videos', body: { data: [] } }])

        await makeClient(fetchImpl).videos.list({ status: 'ready', limit: 10 })

        expect(calls[0].url).toBe(`${BASE}/v1/videos?status=ready&limit=10`)
    })

    it('clamps a limit the API would reject', async () => {
        const { fetchImpl, calls } = makeApi([{ match: '/v1/videos', body: { data: [] } }])

        await makeClient(fetchImpl).videos.list({ limit: 5000 })

        expect(calls[0].url).toBe(`${BASE}/v1/videos?limit=100`)
    })

    it('updates a video using the API field names', async () => {
        const { fetchImpl, calls } = makeApi([
            { match: '/v1/video/vid_1', method: 'PATCH', body: { id: 'vid_1', title: 'New' } },
        ])

        await makeClient(fetchImpl).videos.update('vid_1', {
            title: 'New',
            playbackPolicy: 'signed',
        })

        expect(calls[0].method).toBe('PATCH')
        expect(calls[0].body).toEqual({ title: 'New', playback_policy: 'signed' })
    })

    it('refuses an empty update without a round trip', async () => {
        const { fetchImpl, calls } = makeApi([])

        await expect(makeClient(fetchImpl).videos.update('vid_1', {})).rejects.toThrowError(
            /needs a title or a playbackPolicy/,
        )
        expect(calls).toHaveLength(0)
    })

    it('deletes a video', async () => {
        const { fetchImpl, calls } = makeApi([
            { match: '/v1/video/vid_1', body: { deleted: true, id: 'vid_1' } },
        ])

        const result = await makeClient(fetchImpl).videos.delete('vid_1')

        expect(calls[0].method).toBe('DELETE')
        expect(result.deleted).toBe(true)
    })
})

describe('error mapping', () => {
    it('maps 401 to UNAUTHORIZED with the API message and request id', async () => {
        const { fetchImpl } = makeApi([
            {
                match: '/v1/videos',
                status: 401,
                body: { error: 'Invalid API key' },
                headers: { 'x-request-id': 'req_9' },
            },
        ])

        const error = await makeClient(fetchImpl)
            .videos.list()
            .catch((e) => e)

        expect(error).toBeInstanceOf(OpenVodError)
        expect(error.code).toBe('UNAUTHORIZED')
        expect(error.message).toBe('Invalid API key')
        expect(error.requestId).toBe('req_9')
    })

    it('maps 404 to NOT_FOUND', async () => {
        const { fetchImpl } = makeApi([
            { match: '/v1/video/', status: 404, body: { error: 'Video not found' } },
        ])

        await expect(makeClient(fetchImpl).videos.get('nope')).rejects.toMatchObject({
            code: 'NOT_FOUND',
        })
    })

    it('does not retry a non-idempotent mutation', async () => {
        const { fetchImpl, calls } = makeApi([
            { match: '/v1/videos', status: 500, body: { error: 'boom' }, times: 5 },
        ])

        await expect(
            makeClient(fetchImpl, { maxRetries: 3 }).videos.list({ status: 'ready' }),
        ).rejects.toMatchObject({ code: 'SERVER_ERROR' })

        // GET is idempotent: one initial call plus the retries.
        expect(calls).toHaveLength(4)
    })

    it('retries a POST that is declared safe to retry (token minting)', async () => {
        const { fetchImpl, calls } = makeApi([
            { match: '/v1/upload/token', status: 500, body: { error: 'boom' }, times: 1 },
            { match: '/v1/upload/token', body: { upload_token: 'ut_after_retry' } },
        ])

        const token = await makeClient(fetchImpl, { maxRetries: 2 }).uploads.createToken()

        expect(calls).toHaveLength(2)
        expect(token.upload_token).toBe('ut_after_retry')
    })

    it('honours Retry-After on 429', async () => {
        const delays: number[] = []
        const { fetchImpl } = makeApi([
            {
                match: '/v1/videos',
                status: 429,
                body: { error: 'Rate limit exceeded' },
                headers: { 'Retry-After': '0' },
                times: 1,
            },
            { match: '/v1/videos', body: { data: [] } },
        ])

        // A zero Retry-After keeps the test instant without faking the clock.
        const started = Date.now()
        const result = await makeClient(fetchImpl, { maxRetries: 1 }).videos.list()
        delays.push(Date.now() - started)

        expect(result.data).toEqual([])
        expect(delays[0]).toBeLessThan(1_000)
    })

    it('reports a network failure as retryable', async () => {
        const failing = (async () => {
            throw new TypeError('fetch failed')
        }) as unknown as typeof fetch

        await expect(
            makeClient(failing, { maxRetries: 1 }).videos.get('vid_1'),
        ).rejects.toMatchObject({ code: 'NETWORK', retryable: true })
    })

    it('reports a timeout distinctly', async () => {
        const hanging = (async (_url: string | URL, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    const error = new Error('aborted')
                    error.name = 'AbortError'
                    reject(error)
                })
            })
        }) as unknown as typeof fetch

        await expect(
            makeClient(hanging, { maxRetries: 0, timeoutMs: 20 }).videos.get('vid_1'),
        ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
    })

    it('raises INVALID_REQUEST for an id-less call without a round trip', async () => {
        const { fetchImpl, calls } = makeApi([])

        await expect(makeClient(fetchImpl).videos.get('  ')).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        })
        expect(calls).toHaveLength(0)
    })
})
