import { afterEach, describe, expect, it, vi } from 'vitest'
import { WAE_MAX_DATA_POINTS_PER_INVOCATION } from '../../src/lib/analytics-engine'
import {
  ANALYTICS_FORWARD_MAX_BODY_BYTES,
  deliveryAnalyticsForwarder,
  splitPlaybackForwardBatches,
} from '../../src/runtime/analytics'
import type { PlaybackRow } from '../../src/runtime/types'

const row: PlaybackRow = {
  event: 'play',
  videoId: 'video-1',
  sessionId: 'session-1',
  userId: '',
  country: 'unknown',
  device: 'desktop',
  browser: 'chrome',
  errorCode: '',
  watchedDelta: 1,
  currentTime: 2,
  duration: 10,
  organizationId: 'org_a',
}

describe('deliveryAnalyticsForwarder', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('POSTs normalized rows with the ingest secret and does not retry', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 200 }))
    const port = deliveryAnalyticsForwarder({
      deliveryUrl: 'https://media.example.com/',
      ingestSecret: 'secret-value',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(port.writePlayback([row])).resolves.toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const request = fetchImpl.mock.calls[0]![1] as RequestInit
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://media.example.com/internal/analytics/playback')
    expect(request.headers).toMatchObject({
      authorization: 'Bearer secret-value',
      'content-type': 'application/json',
    })
    const body = JSON.parse(String(request.body)) as { events: PlaybackRow[] }
    expect(body.events[0]?.organizationId).toBe('org_a')
    expect(body.events[0]?.country).toBe('unknown')
  })

  it('times out after five seconds and logs a sanitized failure', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    })
    const port = deliveryAnalyticsForwarder({
      deliveryUrl: 'https://media.example.com',
      ingestSecret: 'super-secret-ingest',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5_000,
    })

    const pending = port.writePlayback([row])
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBe(0)
    expect(errors).toHaveBeenCalled()
    const log = String(errors.mock.calls[0]?.[0])
    expect(log).toContain('[analytics] delivery ingest failed')
    expect(log).not.toContain('super-secret-ingest')
  })

  it('splits a 250-event batch whose serialized body exceeds 1 MiB', async () => {
    const rows: PlaybackRow[] = Array.from({ length: 250 }, (_, i) => ({
      ...row,
      videoId: `video-${String(i).padStart(3, '0')}`,
      sessionId: `session-${String(i).padStart(3, '0')}`,
      userId: 'u'.repeat(4096),
    }))
    const whole = JSON.stringify({ events: rows })
    expect(new TextEncoder().encode(whole).byteLength).toBeGreaterThan(ANALYTICS_FORWARD_MAX_BODY_BYTES)

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: PlaybackRow[] }
      return new Response(JSON.stringify({ accepted: body.events.length }), { status: 200 })
    })
    const port = deliveryAnalyticsForwarder({
      deliveryUrl: 'https://media.example.com',
      ingestSecret: 'secret-value',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(port.writePlayback(rows)).resolves.toBe(250)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)

    const forwarded: PlaybackRow[] = []
    for (const call of fetchImpl.mock.calls) {
      const raw = String((call[1] as RequestInit).body)
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(ANALYTICS_FORWARD_MAX_BODY_BYTES)
      const body = JSON.parse(raw) as { events: PlaybackRow[] }
      expect(body.events.length).toBeLessThanOrEqual(WAE_MAX_DATA_POINTS_PER_INVOCATION)
      forwarded.push(...body.events)
    }
    expect(forwarded.map((event) => event.videoId)).toEqual(rows.map((event) => event.videoId))
  })
})

describe('splitPlaybackForwardBatches', () => {
  it('starts a new batch when the next row would exceed the serialized byte limit', () => {
    const a = { ...row, videoId: 'a' }
    const b = { ...row, videoId: 'b' }
    const c = { ...row, videoId: 'c' }
    const twoBytes = new TextEncoder().encode(JSON.stringify({ events: [a, b] })).byteLength
    const threeBytes = new TextEncoder().encode(JSON.stringify({ events: [a, b, c] })).byteLength
    expect(twoBytes).toBeLessThan(threeBytes)

    expect(splitPlaybackForwardBatches([a, b, c], twoBytes)).toEqual([[a, b], [c]])
  })

  it('caps each batch at 250 events even when the body is under the byte limit', () => {
    const rows = Array.from({ length: 251 }, (_, i) => ({ ...row, videoId: `v${i}` }))
    const batches = splitPlaybackForwardBatches(rows)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(250)
    expect(batches[1]).toEqual([rows[250]])
  })
})
