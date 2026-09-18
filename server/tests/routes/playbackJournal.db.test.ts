import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import analytics from '../../src/routes/analytics'
import { createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'
import { createTestRuntime, fullyConfiguredEnv, withRuntime } from '../helpers/runtime'
import type { PlaybackRow } from '../../src/runtime/types'
import { resetInstalledDb } from '../../src/lib/database'

const VIDEO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VIDEO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const VIDEO_DELETED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const VIDEO_MISSING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function eventFor(videoId: string) {
  return {
    event: 'play',
    ts: '2026-01-01T00:00:00.000Z',
    videoId,
    sessionId: `session-${videoId.slice(0, 8)}`,
    currentTime: 1,
    duration: 10,
    watchedDelta: 0.5,
  }
}

describe.skipIf(!hasTestDatabase)('POST /api/playback/journal ownership', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'clipmux_t_playback_journal' })
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('org_a', 'Org A', 'org-a', now()), ('org_b', 'Org B', 'org-b', now());
      INSERT INTO video (id, organization_id, title, status)
      VALUES
        ('${VIDEO_A}', 'org_a', 'A', 'ready'),
        ('${VIDEO_B}', 'org_b', 'B', 'ready'),
        ('${VIDEO_DELETED}', 'org_a', 'Gone', 'ready');
      UPDATE video SET deleted_at = now() WHERE id = '${VIDEO_DELETED}';
    `)
  })

  afterAll(async () => {
    await handle?.close()
    resetInstalledDb()
  })

  it('assigns each event its own organization and drops unknown or deleted videos', async () => {
    const written: PlaybackRow[][] = []
    const app = withRuntime(
      analytics,
      createTestRuntime(fullyConfiguredEnv({ DATABASE_URL: handle.url }), {
        analytics: {
          canWritePlayback: true,
          writePlayback: async (rows) => {
            written.push(rows)
            return rows.length
          },
        },
      }),
      '/api/playback',
    )

    const res = await app.request('/api/playback/journal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        eventFor(VIDEO_A),
        eventFor(VIDEO_B),
        eventFor(VIDEO_DELETED),
        eventFor(VIDEO_MISSING),
      ]),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; received: number }
    expect(body.received).toBe(4)
    expect(body.count).toBe(2)
    await Promise.resolve()
    expect(written[0]?.map((row) => row.organizationId).sort()).toEqual(['org_a', 'org_b'])
    expect(written[0]?.every((row) => row.country === 'unknown')).toBe(true)
  })

  it('keeps valid events when another video id is not a UUID', async () => {
    const written: PlaybackRow[][] = []
    const app = withRuntime(
      analytics,
      createTestRuntime(fullyConfiguredEnv({ DATABASE_URL: handle.url }), {
        analytics: {
          canWritePlayback: true,
          writePlayback: async (rows) => {
            written.push(rows)
            return rows.length
          },
        },
      }),
      '/api/playback',
    )

    const res = await app.request('/api/playback/journal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([eventFor(VIDEO_A), eventFor('not-a-uuid')]),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; received: number }
    expect(body.received).toBe(2)
    expect(body.count).toBe(1)
    await Promise.resolve()
    expect(written[0]?.map((row) => row.videoId)).toEqual([VIDEO_A])
  })
})
