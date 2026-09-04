import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  dispatchDirectHttp,
  pickDispatcher,
  DispatchError,
} from '../../src/utils/queue'
import type { DispatchPayload } from '../../src/utils/queue'

const PAYLOAD: DispatchPayload = {
  key: 'org1/raw/abc/video.mp4',
  bucket: 'raw-uploads',
  fileId: 'video-1',
  playbackPolicy: 'public',
  generateSubtitle: false,
  generateChapters: false,
  organizationId: 'org1',
  callbackUrl: 'https://api.example.com/api/webhook/transcode-complete',
}

const fetchMock = vi.fn()

describe('pickDispatcher', () => {
  it('prefers QStash when a token is configured', () => {
    expect(pickDispatcher({ QSTASH_TOKEN: 'token' })).toBe('qstash')
  })

  it('falls back to direct HTTP when no QStash token is set', () => {
    expect(pickDispatcher({})).toBe('direct')
  })
})

describe('dispatchDirectHttp', () => {
  const deps = {
    fetchImpl: fetchMock as unknown as typeof fetch,
    sleep: vi.fn(() => Promise.resolve()),
    jitter: vi.fn(() => 0),
  }

  afterEach(() => {
    fetchMock.mockReset()
    deps.sleep.mockClear()
    deps.jitter.mockClear()
  })

  it('POSTs the payload with the ingest secret and resolves on acceptance', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }),
    )

    await dispatchDirectHttp(
      {
        url: 'https://user--app.modal.run/transcode',
        ingestSecret: 'ingest-secret',
        payload: PAYLOAD,
      },
      deps,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://user--app.modal.run/transcode')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ingest-secret',
    )
    const body = JSON.parse(init.body as string)
    expect(body.fileId).toBe('video-1')
    expect(body.bucket).toBe('raw-uploads')
    expect(body.callbackUrl).toBe(PAYLOAD.callbackUrl)
  })

  it('retries with exponential backoff on 5xx and throws a typed error on final failure', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }))

    await expect(
      dispatchDirectHttp(
        {
          url: 'https://user--app.modal.run/transcode',
          ingestSecret: 's',
          payload: PAYLOAD,
        },
        { ...deps, jitter: vi.fn(() => 0) },
      ),
    ).rejects.toMatchObject({ name: 'DispatchError', code: 'HTTP_STATUS' })

    // initial attempt + 5 retries
    expect(fetchMock).toHaveBeenCalledTimes(6)
    // backoff sleeps: base(500) * 2^attempt
    const sleeps = deps.sleep.mock.calls.map(([ms]) => ms as number)
    expect(sleeps).toHaveLength(5)
    expect(sleeps[0]).toBeGreaterThanOrEqual(500)
    expect(sleeps[4]).toBeGreaterThanOrEqual(8000)
  })

  it('does not retry 4xx responses', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }))

    await expect(
      dispatchDirectHttp({
        url: 'https://user--app.modal.run/transcode',
        ingestSecret: 's',
        payload: PAYLOAD,
      }, deps),
    ).rejects.toMatchObject({ code: 'HTTP_STATUS' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats the Modal `accepted` envelope as success and `error` envelope as failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'error', message: 'bad payload' }), {
        status: 200,
      }),
    )

    await expect(
      dispatchDirectHttp({
        url: 'https://user--app.modal.run/transcode',
        ingestSecret: 's',
        payload: PAYLOAD,
      }, deps),
    ).rejects.toMatchObject({ code: 'ENVELOPE_ERROR' })
  })

  it('throws a typed config error when the endpoint is missing', async () => {
    await expect(
      dispatchDirectHttp({
        url: '',
        ingestSecret: 's',
        payload: PAYLOAD,
      }, deps),
    ).rejects.toMatchObject({ name: 'DispatchError', code: 'CONFIG_MISSING' })
  })

  it('propagates network failures as typed NETWORK errors after retries', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(
      dispatchDirectHttp({
        url: 'https://user--app.modal.run/transcode',
        ingestSecret: 's',
        payload: PAYLOAD,
      }, deps),
    ).rejects.toMatchObject({ code: 'NETWORK' })

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })
})
