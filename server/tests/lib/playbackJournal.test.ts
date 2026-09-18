import { describe, expect, it } from 'vitest'
import { WAE_MAX_DATA_POINTS_PER_INVOCATION } from '../../src/lib/analytics-engine'
import {
  AE_BLOB_MAX_BYTES,
  JOURNAL_MAX_BODY_BYTES,
  bodyByteLength,
  parseJournalEvents,
  readTextWithLimit,
  toPlaybackRow,
} from '../../src/lib/playbackJournal'

const validEvent = {
  event: 'play',
  ts: '2026-01-01T00:00:00.000Z',
  videoId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: 'session-1',
  currentTime: 1,
  duration: 10,
  watchedDelta: 0.5,
}

describe('parseJournalEvents', () => {
  it('rejects a non-array or empty body', () => {
    expect(parseJournalEvents(null)).toMatchObject({ ok: false, status: 400 })
    expect(parseJournalEvents([])).toMatchObject({ ok: false, status: 400 })
    expect(parseJournalEvents({ event: 'play' })).toMatchObject({ ok: false, status: 400 })
  })

  it('keeps valid events and drops malformed ones', () => {
    const result = parseJournalEvents([
      validEvent,
      { ...validEvent, event: '' },
      { ...validEvent, currentTime: Number.NaN },
      { ...validEvent, watchedDelta: Infinity },
      { ...validEvent, sessionId: 12 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.received).toBe(5)
    expect(result.events).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('caps accepted events at the Analytics Engine invocation limit', () => {
    const events = Array.from({ length: WAE_MAX_DATA_POINTS_PER_INVOCATION + 3 }, (_, i) => ({
      ...validEvent,
      sessionId: `session-${i}`,
    }))
    const result = parseJournalEvents(events)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.received).toBe(WAE_MAX_DATA_POINTS_PER_INVOCATION + 3)
    expect(result.events).toHaveLength(WAE_MAX_DATA_POINTS_PER_INVOCATION)
    expect(result.truncated).toBe(true)
  })

  it('rejects a blob that exceeds the dataset field-size limit', () => {
    const huge = 'x'.repeat(AE_BLOB_MAX_BYTES + 1)
    const result = parseJournalEvents([{ ...validEvent, event: huge }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.events).toHaveLength(0)
  })

  it('drops an event whose combined blobs exceed 16 KiB', () => {
    // Worked example: 9_000 + 9_000 + the remaining playback_events blobs = 18_060
    // UTF-8 bytes, each field under the per-blob cap. Cloudflare limits the
    // combined blobs of one data point to 16 KiB, not each field.
    const oversized = {
      ...validEvent,
      sessionId: 's'.repeat(9_000),
      userId: 'u'.repeat(9_000),
    }
    const parsed = parseJournalEvents([oversized])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.events).toHaveLength(1)
    const row = toPlaybackRow(parsed.events[0]!, {
      organizationId: 'org_1',
      country: 'unknown',
      device: 'desktop',
      browser: 'chrome',
    })
    expect(row).toBeNull()
  })
})

describe('toPlaybackRow', () => {
  it('copies viewer metadata from the API, including unknown country', () => {
    const parsed = parseJournalEvents([validEvent])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const row = toPlaybackRow(parsed.events[0]!, {
      organizationId: 'org_1',
      country: 'unknown',
      device: 'desktop',
      browser: 'chrome',
    })
    expect(row).toMatchObject({
      organizationId: 'org_1',
      country: 'unknown',
      device: 'desktop',
      browser: 'chrome',
      videoId: validEvent.videoId,
    })
  })
})

describe('journal body limit', () => {
  it('measures UTF-8 bytes, not string length', () => {
    expect(JOURNAL_MAX_BODY_BYTES).toBe(1024 * 1024)
    expect(bodyByteLength('é')).toBe(2)
  })

  it('rejects a declared Content-Length over the cap without reading the stream', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new TextEncoder().encode('x'))
      },
    })
    const request = new Request('http://127.0.0.1/api/playback/journal', {
      method: 'POST',
      headers: { 'content-length': String(JOURNAL_MAX_BODY_BYTES + 1) },
      body,
      duplex: 'half',
    } as RequestInit)
    const result = await readTextWithLimit(request, JOURNAL_MAX_BODY_BYTES)
    expect(result).toEqual({ ok: false, status: 413, error: 'Payload too large' })
    expect(pulls).toBe(0)
  })

  it('stops reading once the byte cap is exceeded', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('a'.repeat(8)))
        controller.enqueue(encoder.encode('b'.repeat(8)))
        controller.close()
      },
    })
    const request = new Request('http://127.0.0.1/api/playback/journal', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)
    const result = await readTextWithLimit(request, 10)
    expect(result).toEqual({ ok: false, status: 413, error: 'Payload too large' })
  })
})
