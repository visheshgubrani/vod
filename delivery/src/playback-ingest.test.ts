import { describe, expect, it } from 'vitest'
import {
  INGEST_MAX_BODY_BYTES,
  authorizeIngest,
  handlePlaybackIngestRequest,
  ingestPlaybackEvents,
  playbackDataPoint,
  parseIngestRows,
} from './playback-ingest'

const row = {
  event: 'play',
  videoId: 'video-1',
  sessionId: 'session-1',
  userId: '',
  country: 'DE',
  device: 'desktop',
  browser: 'firefox',
  errorCode: '',
  watchedDelta: 1,
  currentTime: 2,
  duration: 10,
  organizationId: 'org_a',
}

describe('playback ingest', () => {
  it('preserves the historical playback_events field layout', () => {
    expect(playbackDataPoint(row)).toEqual({
      blobs: ['play', 'video-1', 'session-1', 'DE', 'desktop', 'firefox', '', ''],
      doubles: [1, 2, 10],
      indexes: ['org_a'],
    })
  })

  it('rejects unauthorized requests before writing', () => {
    const points: unknown[] = []
    const result = ingestPlaybackEvents({
      method: 'POST',
      authorized: false,
      body: { events: [row] },
      env: {
        ANALYTICS_INGEST_SECRET: 'secret',
        PLAYBACK_ANALYTICS: { writeDataPoint: (point) => points.push(point) },
      },
    })
    expect(result.status).toBe(401)
    expect(points).toHaveLength(0)
  })

  it('rejects a malformed payload', () => {
    const result = ingestPlaybackEvents({
      method: 'POST',
      authorized: true,
      body: [row],
      env: {
        ANALYTICS_INGEST_SECRET: 'secret',
        PLAYBACK_ANALYTICS: { writeDataPoint: () => {} },
      },
    })
    expect(result.status).toBe(400)
  })

  it('returns 503 when the binding is missing or analytics is disabled', () => {
    expect(
      ingestPlaybackEvents({
        method: 'POST',
        authorized: true,
        body: { events: [row] },
        env: { ANALYTICS_INGEST_SECRET: 'secret' },
      }).status,
    ).toBe(503)
    expect(
      ingestPlaybackEvents({
        method: 'POST',
        authorized: true,
        body: { events: [row] },
        env: {
          ANALYTICS_ENABLED: 'false',
          ANALYTICS_INGEST_SECRET: 'secret',
          PLAYBACK_ANALYTICS: { writeDataPoint: () => {} },
        },
      }).status,
    ).toBe(503)
  })

  it('writes viewer metadata from the payload, not the Node host', () => {
    const points: ReturnType<typeof playbackDataPoint>[] = []
    const result = ingestPlaybackEvents({
      method: 'POST',
      authorized: true,
      body: { events: [row] },
      env: {
        ANALYTICS_INGEST_SECRET: 'secret',
        PLAYBACK_ANALYTICS: { writeDataPoint: (point) => points.push(point) },
      },
    })
    expect(result).toEqual({ status: 200, body: { accepted: 1 } })
    expect(points[0]?.blobs[3]).toBe('DE')
    expect(points[0]?.blobs[5]).toBe('firefox')
  })

  it('parses mixed-organization batches independently', () => {
    const rows = parseIngestRows({
      events: [
        { ...row, organizationId: 'org_a', videoId: 'v1' },
        { ...row, organizationId: 'org_b', videoId: 'v2' },
      ],
    })
    expect(rows?.map((item) => item.organizationId)).toEqual(['org_a', 'org_b'])
  })

  it('drops a row whose combined blobs exceed 16 KiB', () => {
    const rows = parseIngestRows({
      events: [
        {
          ...row,
          sessionId: 's'.repeat(9_000),
          userId: 'u'.repeat(9_000),
        },
      ],
    })
    expect(rows).toEqual([])
  })
})

describe('handlePlaybackIngestRequest', () => {
  it('returns 401 without waiting for an unauthenticated body to finish', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueue or close: request.json() would hang.
      },
    })
    const response = await Promise.race([
      handlePlaybackIngestRequest(
        new Request('https://media.example.com/internal/analytics/playback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          duplex: 'half',
        } as RequestInit),
        { ANALYTICS_INGEST_SECRET: 'secret' },
      ),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error('handler waited for the body')), 250)
      }),
    ])
    expect(response.status).toBe(401)
  })

  it('returns 413 when Content-Length exceeds 1 MiB after auth', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueue or close: a full read would hang.
      },
    })
    const response = await Promise.race([
      handlePlaybackIngestRequest(
        new Request('https://media.example.com/internal/analytics/playback', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-analytics-ingest-secret': 'secret',
            'content-length': String(INGEST_MAX_BODY_BYTES + 1),
          },
          body,
          duplex: 'half',
        } as RequestInit),
        {
          ANALYTICS_INGEST_SECRET: 'secret',
          PLAYBACK_ANALYTICS: { writeDataPoint: () => {} },
        },
      ),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error('handler waited for the body')), 250)
      }),
    ])
    expect(response.status).toBe(413)
  })
})

describe('authorizeIngest', () => {
  const env = { ANALYTICS_INGEST_SECRET: 'shared-secret' }

  it('accepts bearer or dedicated header', () => {
    expect(
      authorizeIngest(new Request('https://media.example.com/internal/analytics/playback', {
        headers: { authorization: 'Bearer shared-secret' },
      }), env),
    ).toBe(true)
    expect(
      authorizeIngest(new Request('https://media.example.com/internal/analytics/playback', {
        headers: { 'x-analytics-ingest-secret': 'shared-secret' },
      }), env),
    ).toBe(true)
    expect(
      authorizeIngest(new Request('https://media.example.com/internal/analytics/playback', {
        headers: { authorization: 'Bearer other' },
      }), env),
    ).toBe(false)
  })
})
