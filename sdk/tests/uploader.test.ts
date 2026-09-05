import { describe, expect, it, vi, afterEach } from 'vitest'
import { OpenVodUploader } from '../src/uploader'

/**
 * Protocol-level fake server: exercises the exact API surface the SDK talks
 * to (create -> windowed /parts -> PUT -> complete) without network.
 */
function makeProtocolServer(partCount = 4, partSize = 1024 * 1024) {
  const puts: Array<{ part: number; bytes: number }> = []
  const windowCalls: number[][] = []
  const state = {
    create: 0,
    parts: 0,
    complete: 0,
    completedParts: [] as number[],
    /** map part -> status to simulate failures/expiry */
    failPut: new Map<number, number>(), // part -> status code (once)
    refuseFirstWindow: false,
  }

  const server = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (method === 'PUT') {
      const m = url.match(/^https:\/\/r2\.example\.com\/part\/(\d+)/)
      if (!m) return new Response('bad url', { status: 400 })
      const part = Number(m[1])
      const fail = state.failPut.get(part)
      if (fail !== undefined) {
        state.failPut.delete(part)
        return new Response('expired', { status: fail })
      }
      const body = init?.body as Blob
      puts.push({ part, bytes: body ? body.size : 0 })
      return new Response(null, { status: 200, headers: { ETag: `"etag-${part}"` } })
    }

    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.endsWith('/v1/upload/create')) {
      state.create += 1
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
      if (state.refuseFirstWindow && state.parts === 1) {
        return new Response('nope', { status: 401 })
      }
      windowCalls.push([...body.part_numbers].sort((a, b) => a - b))
      return Response.json({
        part_size: partSize,
        part_count: partCount,
        urls: (body.part_numbers as number[]).map((n: number) => ({
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
      return Response.json({ aborted: true, deleted: true })
    }
    return new Response('not found', { status: 404 })
  }

  return { server, puts, windowCalls, state }
}

function makeFile(bytes: number): File {
  return new File([new Uint8Array(bytes)], 'clip.mp4', { type: 'video/mp4' })
}

const BASE = 'https://api.example.com'

describe('OpenVodUploader windowed upload', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fetches part URLs in windows of the configured size', async () => {
    const { server, windowCalls, state } = makeProtocolServer(7, 1024 * 1024)
    const uploader = new OpenVodUploader({
      baseUrl: BASE,
      uploadToken: 'ut_token',
      windowSize: 3,
      fetchImpl: server as unknown as typeof fetch,
    })
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)

    const result = await uploader.upload(makeFile(6 * 1024 * 1024 + 500))

    expect(result.fileId).toBe('video-1')
    expect(state.create).toBe(1)
    // 7 parts with window 3 => 3 windows: [1,2,3], [4,5,6], [7]
    expect(windowCalls).toEqual([[1, 2, 3], [4, 5, 6], [7]])
    expect(state.complete).toBe(1)
    expect(state.completedParts).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('retries expired presigned URLs once per window by refetching', async () => {
    const { server, state } = makeProtocolServer(4)
    const uploader = new OpenVodUploader({
      baseUrl: BASE,
      uploadToken: 'ut_token',
      windowSize: 4,
      fetchImpl: server as unknown as typeof fetch,
    })
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
      cb()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)

    // Part 2's presigned URL is expired (403) on first PUT.
    state.failPut.set(2, 403)

    const result = await uploader.upload(makeFile(4 * 1024 * 1024))
    expect(result.fileId).toBe('video-1')
    // window refetched once after the 403
    expect(state.parts).toBe(2)
    expect(state.completedParts).toEqual([1, 2, 3, 4])
  })

  it('retries transient 5xx PUT failures with backoff', async () => {
    const { server, state } = makeProtocolServer(2)
    const uploader = new OpenVodUploader({
      baseUrl: BASE,
      uploadToken: 'ut_token',
      windowSize: 2,
      maxRetries: 2,
      retryDelay: 1,
      fetchImpl: server as unknown as typeof fetch,
    })
    state.failPut.set(1, 503)

    const result = await uploader.upload(makeFile(2 * 1024 * 1024))
    expect(result.fileId).toBe('video-1')
    expect(state.completedParts).toEqual([1, 2])
  })

  it('surfaces progress totals and part counts', async () => {
    const { server } = makeProtocolServer(3, 1024 * 1024)
    const uploader = new OpenVodUploader({
      baseUrl: BASE,
      uploadToken: 'ut_token',
      windowSize: 2,
      fetchImpl: server as unknown as typeof fetch,
    })
    const progress: number[] = []
    await uploader.upload(makeFile(3 * 1024 * 1024), {
      onProgress: (p) => progress.push(p.percentage),
    })
    expect(progress[progress.length - 1]).toBe(100)
    expect(progress.some((p) => p > 0 && p < 100)).toBe(true)
    // never NaN (0-byte guard style)
    expect(progress.every((p) => Number.isFinite(p))).toBe(true)
  })

  it('supports abort via AbortSignal before parts start', async () => {
    const { server } = makeProtocolServer(4)
    const uploader = new OpenVodUploader({
      baseUrl: BASE,
      uploadToken: 'ut_token',
      fetchImpl: server as unknown as typeof fetch,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(uploader.upload(makeFile(1024), { signal: controller.signal })).rejects.toThrow(
      'Upload aborted',
    )
  })

  it('calls the abort endpoint for explicit abort()', async () => {
    const { server } = makeProtocolServer(4)
    const uploader = new OpenVodUploader({
      baseUrl: BASE,
      uploadToken: 'ut_token',
      fetchImpl: server as unknown as typeof fetch,
    })
    const result = await uploader.abort('org/raw/video-1/a.mp4', 'upload-1', 'video-1')
    expect(result).toEqual({ aborted: true, deleted: true })
  })
})
