import { describe, expect, it } from 'vitest'
import { OpenVodUploader, computePartPlan, resolveContentType } from '../src/uploader'
import { OpenVodError, UploadAbortedError } from '../src/errors'

/**
 * Protocol-level fake server: exercises the exact API surface the SDK talks to
 * (create -> windowed /parts -> PUT -> complete) without network.
 *
 * `delayImpl` replaces real waiting and records the delays, so the retry tests
 * assert on the backoff the SDK *chose* rather than racing a clock.
 */
function makeProtocolServer(partCount = 4, partSize = 1024 * 1024) {
    const puts: number[] = []
    const windowCalls: number[][] = []
    const delays: number[] = []

    const state = {
        create: 0,
        parts: 0,
        complete: 0,
        abort: 0,
        completedParts: [] as number[],
        /** part -> status, consumed once (simulates an expired presigned URL). */
        failPut: new Map<number, number>(),
        /** part -> status, on every attempt (simulates a permanently bad part). */
        alwaysFailPut: new Map<number, number>(),
        /** status codes to return for successive /parts calls (0 = success). */
        partsStatuses: [] as number[],
        partsRetryAfter: undefined as string | undefined,
        /** status/body for /create. */
        createStatus: 0,
        createBody: undefined as unknown,
        requestId: undefined as string | undefined,
        /** override the plan echoed by /parts (to test drift detection). */
        planOverride: undefined as { part_size: number; part_count: number } | undefined,
        onPut: undefined as ((part: number) => void | Promise<void>) | undefined,
    }

    const server = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (method === 'PUT') {
            const match = url.match(/^https:\/\/r2\.example\.com\/part\/(\d+)/)
            if (!match) return new Response('bad url', { status: 400 })
            const part = Number(match[1])

            await state.onPut?.(part)

            const alwaysFail = state.alwaysFailPut.get(part)
            if (alwaysFail !== undefined) return new Response('nope', { status: alwaysFail })

            const fail = state.failPut.get(part)
            if (fail !== undefined) {
                state.failPut.delete(part)
                return new Response('expired', { status: fail })
            }

            const body = init?.body as Blob
            puts.push(part)
            expect(body?.size ?? 0).toBeGreaterThan(0)
            return new Response(null, { status: 200, headers: { ETag: `"etag-${part}"` } })
        }

        const body = init?.body ? JSON.parse(String(init.body)) : {}

        if (url.endsWith('/v1/upload/create')) {
            state.create += 1
            if (state.createStatus) {
                return Response.json(state.createBody ?? { error: 'nope' }, {
                    status: state.createStatus,
                    headers: state.requestId ? { 'x-request-id': state.requestId } : {},
                })
            }
            return Response.json({
                upload_id: 'upload-1',
                file_id: 'video-1',
                key: 'org/raw/video-1/a.mp4',
                part_size: partSize,
                part_count: partCount,
            })
        }

        if (url.endsWith('/v1/upload/parts')) {
            state.parts += 1
            const status = state.partsStatuses.shift() ?? 0
            if (status) {
                return new Response('slow down', {
                    status,
                    headers: state.partsRetryAfter ? { 'Retry-After': state.partsRetryAfter } : {},
                })
            }
            windowCalls.push([...(body.part_numbers as number[])].sort((a, b) => a - b))
            const plan = state.planOverride ?? { part_size: partSize, part_count: partCount }
            return Response.json({
                part_size: plan.part_size,
                part_count: plan.part_count,
                urls: (body.part_numbers as number[]).map((n) => ({
                    part_number: n,
                    url: `https://r2.example.com/part/${n}`,
                    size: n === partCount ? partSize - 100 : partSize,
                })),
            })
        }

        if (url.endsWith('/v1/upload/complete')) {
            state.complete += 1
            state.completedParts = (body.parts as Array<{ part_number: number }>)
                .map((p) => p.part_number)
                .sort((a, b) => a - b)
            return Response.json({ file_id: 'video-1', key: body.key, etag: 'x' })
        }

        if (url.endsWith('/v1/upload/abort')) {
            state.abort += 1
            return Response.json({ aborted: true, deleted: true })
        }

        return new Response('not found', { status: 404 })
    }

    return { server, puts, windowCalls, delays, state }
}

function makeUploader(
    server: typeof fetch,
    delays: number[],
    overrides: Record<string, unknown> = {},
): OpenVodUploader {
    return new OpenVodUploader({
        baseUrl: BASE,
        uploadToken: 'ut_token',
        fetchImpl: server,
        delayImpl: async (ms: number) => {
            delays.push(ms)
        },
        ...overrides,
    })
}

function makeFile(bytes: number): File {
    return new File([new Uint8Array(bytes)], 'clip.mp4', { type: 'video/mp4' })
}

/** Let queued microtasks and one macrotask turn settle. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5))
}

const BASE = 'https://api.example.com'

describe('uploader windowing', () => {
    it('fetches part URLs in windows of the configured size', async () => {
        const { server, windowCalls, delays, state } = makeProtocolServer(7, 1024 * 1024)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { windowSize: 3 })

        const result = await uploader.upload(makeFile(6 * 1024 * 1024 + 500))

        expect(result.fileId).toBe('video-1')
        expect(result.key).toBe('org/raw/video-1/a.mp4')
        expect(result.uploadId).toBe('upload-1')
        expect(state.create).toBe(1)
        // 7 parts with window 3 => 3 windows: [1,2,3], [4,5,6], [7]
        expect(windowCalls).toEqual([[1, 2, 3], [4, 5, 6], [7]])
        expect(state.complete).toBe(1)
        expect(state.completedParts).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    it('re-fetches a window once when a part URL is rejected as expired', async () => {
        const { server, delays, state } = makeProtocolServer(4)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { windowSize: 4 })

        state.failPut.set(2, 403)

        const result = await uploader.upload(makeFile(4 * 1024 * 1024))

        expect(result.fileId).toBe('video-1')
        expect(state.parts).toBe(2) // initial window + one refresh
        expect(state.completedParts).toEqual([1, 2, 3, 4])
    })

    it('reports a rejected part URL that is still rejected after a refresh', async () => {
        const { server, delays, state } = makeProtocolServer(2)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, {
            windowSize: 2,
            maxRetries: 0,
        })

        state.alwaysFailPut.set(1, 403)

        await expect(uploader.upload(makeFile(2 * 1024 * 1024))).rejects.toMatchObject({
            name: 'OpenVodError',
            code: 'PART_URL_REJECTED',
            status: 403,
        })
    })

    it('rejects a part plan that changed between create and parts', async () => {
        const { server, delays, state } = makeProtocolServer(2)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { windowSize: 2 })

        state.planOverride = { part_size: 2 * 1024 * 1024, part_count: 1 }

        await expect(uploader.upload(makeFile(2 * 1024 * 1024))).rejects.toMatchObject({
            code: 'PART_CONFIG_INVALID',
        })
    })
})

describe('uploader retries and typed errors', () => {
    it('retries transient 5xx PUT failures with backoff', async () => {
        const { server, delays, state } = makeProtocolServer(2)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, {
            windowSize: 2,
            maxRetries: 2,
            retryDelay: 10,
        })

        state.failPut.set(1, 503)

        const result = await uploader.upload(makeFile(2 * 1024 * 1024))

        expect(result.fileId).toBe('video-1')
        expect(state.completedParts).toEqual([1, 2])
        expect(delays[0]).toBeGreaterThanOrEqual(10) // exponential base
    })

    it('honours Retry-After on a 429 from /parts', async () => {
        const { server, windowCalls, delays, state } = makeProtocolServer(2)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { windowSize: 2 })

        state.partsStatuses = [429]
        state.partsRetryAfter = '2'

        const result = await uploader.upload(makeFile(2 * 1024 * 1024))

        expect(result.fileId).toBe('video-1')
        expect(state.parts).toBe(2) // one rejected, one served
        expect(delays).toEqual([2000]) // the header, not the exponential default
        expect(windowCalls).toEqual([[1, 2]])
    })

    it('gives up on a persistent 429 with a RATE_LIMITED code', async () => {
        const { server, delays, state } = makeProtocolServer(2)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, {
            windowSize: 2,
            maxRetries: 1,
        })

        state.partsStatuses = [429, 429]

        await expect(uploader.upload(makeFile(2 * 1024 * 1024))).rejects.toMatchObject({
            code: 'RATE_LIMITED',
            status: 429,
            retryable: true,
            retryAfterMs: undefined,
        })
    })

    it('maps an expired upload token without retrying it', async () => {
        const { server, delays, state } = makeProtocolServer(2)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { maxRetries: 3 })

        state.createStatus = 401
        state.createBody = { error: 'Upload token has expired' }
        state.requestId = 'req_123'

        const error = await uploader.upload(makeFile(2 * 1024 * 1024)).catch((e) => e)

        expect(error).toBeInstanceOf(OpenVodError)
        expect(error.code).toBe('UPLOAD_TOKEN_EXPIRED')
        expect(error.status).toBe(401)
        expect(error.requestId).toBe('req_123')
        expect(error.retryable).toBe(false)
        expect(state.create).toBe(1) // no retry: a new token is required
        expect(delays).toEqual([])
    })

    it('maps a spent upload token to its own code', async () => {
        const { server, delays, state } = makeProtocolServer(2)
        const uploader = makeUploader(server as unknown as typeof fetch, delays)

        state.createStatus = 401
        state.createBody = { error: 'Upload token has been fully used' }

        await expect(uploader.upload(makeFile(1024))).rejects.toMatchObject({
            code: 'UPLOAD_TOKEN_EXHAUSTED',
        })
    })

    it('retries a transport failure on /parts and succeeds', async () => {
        const inner = makeProtocolServer(2)
        let failed = false
        const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (!failed && String(input).endsWith('/v1/upload/parts')) {
                failed = true
                throw new TypeError('fetch failed')
            }
            return inner.server(input, init)
        }) as unknown as typeof fetch

        const uploader = makeUploader(flaky, inner.delays, { windowSize: 2 })
        const result = await uploader.upload(makeFile(2 * 1024 * 1024))

        expect(result.fileId).toBe('video-1')
        expect(failed).toBe(true)
        expect(inner.delays.length).toBe(1)
        expect(inner.state.completedParts).toEqual([1, 2])
    })
})

describe('uploader progress, pause and resume', () => {
    it('surfaces progress totals and part counts', async () => {
        const { server, delays } = makeProtocolServer(3, 1024 * 1024)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { windowSize: 2 })

        const progress: number[] = []
        await uploader.upload(makeFile(3 * 1024 * 1024), {
            onProgress: (p) => progress.push(p.percentage),
        })

        expect(progress[progress.length - 1]).toBe(100)
        expect(progress.some((p) => p > 0 && p < 100)).toBe(true)
        expect(progress.every((p) => Number.isFinite(p))).toBe(true)
    })

    it('stops scheduling parts while paused and finishes after resume', async () => {
        const { server, puts, delays, state } = makeProtocolServer(3, 1024 * 1024)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { concurrency: 1 })

        const session = uploader.startUpload(makeFile(3 * 1024 * 1024))
        // Pause from inside the first part's PUT: the part still finishes, but
        // nothing new may be scheduled after it.
        state.onPut = (part) => {
            if (part === 1) session.pause()
        }

        const running = session.run()

        await settle()
        expect(puts).toEqual([1])
        expect(session.progress.phase).toBe('paused')

        session.resume()
        const result = await running

        expect(result.status).toBe('processing')
        expect(puts).toEqual([1, 2, 3])
        expect(state.completedParts).toEqual([1, 2, 3])
    })

    it('resumes from serialized state without re-uploading completed parts', async () => {
        const first = makeProtocolServer(4, 1024 * 1024)
        const uploader = makeUploader(first.server as unknown as typeof fetch, first.delays, {
            concurrency: 3,
        })

        // Part 2 never lands, so the first attempt fails after its retries.
        first.state.alwaysFailPut.set(2, 400)
        const session = uploader.startUpload(makeFile(4 * 1024 * 1024), {
            title: 'Resumable',
            playbackPolicy: 'signed',
        })

        await expect(session.run()).rejects.toBeInstanceOf(OpenVodError)

        const state = session.toJSON()
        expect(state.version).toBe(1)
        expect(state.completedParts.length).toBeGreaterThan(0)
        expect(state.completedParts.some((p) => p.part_number === 2)).toBe(false)
        expect(state.options).toMatchObject({ title: 'Resumable', playbackPolicy: 'signed' })

        // A fresh uploader (simulating a reloaded page) continues from the state.
        const second = makeProtocolServer(4, 1024 * 1024)
        const resumedUploader = makeUploader(
            second.server as unknown as typeof fetch,
            second.delays,
            { concurrency: 3 },
        )
        const resumed = resumedUploader.resumeUpload(JSON.parse(JSON.stringify(state)), makeFile(4 * 1024 * 1024))
        const result = await resumed.run()

        expect(result.fileId).toBe('video-1')
        expect(second.state.create).toBe(0) // create was not repeated
        expect(second.puts).not.toContain(1) // already-completed part skipped
        expect(second.state.completedParts).toEqual([1, 2, 3, 4])
    })

    it('refuses to resume against a file of a different size', async () => {
        const { server, delays } = makeProtocolServer(2)
        const uploader = makeUploader(server as unknown as typeof fetch, delays)

        expect(() =>
            uploader.resumeUpload(
                {
                    version: 1,
                    key: 'k',
                    uploadId: 'u',
                    fileId: 'f',
                    partSize: 1024,
                    partCount: 2,
                    filename: 'clip.mp4',
                    fileSize: 2048,
                    contentType: 'video/mp4',
                    completedParts: [],
                    bytesUploaded: 0,
                    options: {},
                },
                makeFile(4096),
            ),
        ).toThrowError(/saved upload was for 2048 bytes/)
    })
})

describe('uploader cancellation', () => {
    it('rejects an aborted signal before any part starts', async () => {
        const { server, delays, state } = makeProtocolServer(4)
        const uploader = makeUploader(server as unknown as typeof fetch, delays)

        const controller = new AbortController()
        controller.abort()

        await expect(
            uploader.upload(makeFile(1024), { signal: controller.signal }),
        ).rejects.toBeInstanceOf(UploadAbortedError)
        expect(state.create).toBe(0)
    })

    it('cancel() abandons the multipart upload and stops the session', async () => {
        const { server, delays, state } = makeProtocolServer(4, 1024 * 1024)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { concurrency: 1 })

        const session = uploader.startUpload(makeFile(4 * 1024 * 1024))
        state.onPut = async (part) => {
            if (part === 1) await settle()
        }

        const running = session.run()
        await settle()
        await session.cancel()

        await expect(running).rejects.toBeInstanceOf(UploadAbortedError)
        expect(state.abort).toBe(1)
    })

    it('calls the abort endpoint for explicit abort()', async () => {
        const { server, delays } = makeProtocolServer(4)
        const uploader = makeUploader(server as unknown as typeof fetch, delays)

        const result = await uploader.abort('org/raw/video-1/a.mp4', 'upload-1', 'video-1')

        expect(result).toEqual({ aborted: true, deleted: true })
    })
})

describe('uploader inputs', () => {
    it('uploads a Blob with an explicit filename and content type', async () => {
        const { server, delays, state } = makeProtocolServer(2, 1024 * 1024)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { windowSize: 2 })

        const blob = new Blob([new Uint8Array(2 * 1024 * 1024)])
        let sentBody: Record<string, unknown> = {}
        const spyServer = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith('/v1/upload/create')) {
                sentBody = JSON.parse(String(init?.body))
            }
            return server(input, init)
        }) as unknown as typeof fetch

        const result = await makeUploader(spyServer, delays, { windowSize: 2 }).upload(blob, {
            filename: 'recording.mkv',
            contentType: 'video/x-matroska',
            title: 'Recording',
        })

        expect(result.title).toBe('Recording')
        expect(sentBody.filename).toBe('recording.mkv')
        expect(sentBody.content_type).toBe('video/x-matroska')
        expect(sentBody.size).toBe(2 * 1024 * 1024)
        expect(state.completedParts).toEqual([1, 2])
    })

    it('runs two concurrent uploads independently', async () => {
        const first = makeProtocolServer(2, 1024 * 1024)
        const second = makeProtocolServer(3, 1024 * 1024)
        const delays: number[] = []

        const firstUploader = makeUploader(first.server as unknown as typeof fetch, delays)
        const secondUploader = makeUploader(second.server as unknown as typeof fetch, delays)

        const [a, b] = await Promise.all([
            firstUploader.upload(makeFile(2 * 1024 * 1024)),
            secondUploader.upload(makeFile(3 * 1024 * 1024)),
        ])

        expect(a.bytesUploaded).toBe(2 * 1024 * 1024)
        expect(b.bytesUploaded).toBe(3 * 1024 * 1024)
        expect(first.state.completedParts).toEqual([1, 2])
        expect(second.state.completedParts).toEqual([1, 2, 3])
    })

    it('clamps the window size to the server cap', async () => {
        const { server, delays } = makeProtocolServer(2, 1024 * 1024)
        const uploader = makeUploader(server as unknown as typeof fetch, delays, { windowSize: 5000 })

        expect(uploader.windowSize).toBe(100)
    })
})

describe('pure helpers', () => {
    it('computes part ranges that cover the file exactly', () => {
        const plan = computePartPlan(10, 4)

        expect(plan).toEqual([
            { partNumber: 1, start: 0, end: 4 },
            { partNumber: 2, start: 4, end: 8 },
            { partNumber: 3, start: 8, end: 10 },
        ])
        expect(plan.reduce((sum, p) => sum + (p.end - p.start), 0)).toBe(10)
    })

    it('resolves a content type from the override, the Blob, then the extension', () => {
        expect(resolveContentType(makeFile(1), 'video/custom')).toBe('video/custom')
        expect(resolveContentType(makeFile(1))).toBe('video/mp4')
        expect(resolveContentType(new Blob([new Uint8Array(1)]), undefined)).toBe('video/mp4')
    })
})
