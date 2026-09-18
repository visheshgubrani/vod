import { afterEach, describe, expect, it, vi } from 'vitest'
import analytics from '../../src/routes/analytics'
import { JOURNAL_MAX_BODY_BYTES } from '../../src/lib/playbackJournal'
import type { PlaybackRow } from '../../src/runtime/types'
import { createTestRuntime, fullyConfiguredEnv, withRuntime } from '../helpers/runtime'
import { resetInstalledDb } from '../../src/lib/database'
import { resetInstalledR2 } from '../../src/utils/R2'

const event = {
  event: 'play',
  ts: '2026-01-01T00:00:00.000Z',
  videoId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: 'session-1',
  currentTime: 1,
  duration: 10,
  watchedDelta: 0.5,
}

afterEach(() => {
  resetInstalledDb()
  resetInstalledR2()
})

describe('POST /api/playback/journal', () => {
  it('rejects a body over 1 MiB', async () => {
    const app = withRuntime(
      analytics,
      createTestRuntime(fullyConfiguredEnv()),
      '/api/playback',
    )
    const res = await app.request('/api/playback/journal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(JOURNAL_MAX_BODY_BYTES + 1),
    })
    expect(res.status).toBe(413)
  })

  it('returns count 0 when analytics cannot write, without implying a writer error', async () => {
    const app = withRuntime(
      analytics,
      createTestRuntime({ ...fullyConfiguredEnv(), ANALYTICS_ENABLED: 'false' }),
      '/api/playback',
    )
    const res = await app.request('/api/playback/journal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([event]),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; received: number; disabled: boolean }
    expect(body.received).toBe(1)
    expect(body.count).toBe(0)
    expect(body.disabled).toBe(true)
  })

  it('returns 500 when the database cannot resolve ownership', async () => {
    const app = withRuntime(
      analytics,
      createTestRuntime(fullyConfiguredEnv(), {
        analytics: {
          canWritePlayback: true,
          writePlayback: async (rows) => rows.length,
        },
      }),
      '/api/playback',
    )

    const res = await app.request('/api/playback/journal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([event]),
    })
    expect(res.status).toBe(500)
  })
})
