import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { writeLifecycleEvent, newEventId } from '../../src/lib/lifecycleOutbox'
import { normalizeRows } from '../../src/lib/atomicWrite'
import { createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'

/**
 * Acceptance test 4: "Process exits between lifecycle update and event
 * creation: event remains recoverable."
 *
 * The exit itself cannot be simulated, so the property is asserted directly:
 * after the write returns, the state change and its event are BOTH present, and
 * a replayed delivery adds no second event. If the two could diverge, a crash
 * in the window between them would lose the event — which is exactly how
 * `video.ready` goes missing today.
 */

const VIDEO_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const VIDEO_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const ORG = 'org-outbox'

const DDL = `
  DELETE FROM event_outbox WHERE organization_id = '${ORG}';
  DELETE FROM video WHERE organization_id = '${ORG}';
  DELETE FROM organization WHERE id = '${ORG}';
  INSERT INTO organization (id, name, slug, created_at)
  VALUES ('${ORG}', 'Outbox', 'outbox-org', now());
  INSERT INTO video (id, organization_id, title, status, transcode_attempt_id)
  VALUES ('${VIDEO_1}', '${ORG}', 'First', 'processing', 'att-1'),
         ('${VIDEO_2}', '${ORG}', 'Second', 'processing', 'att-2');
`

describe('newEventId', () => {
  it('produces distinct, receiver-safe ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newEventId()))
    expect(ids.size).toBe(50)
    for (const id of ids) {
      expect(id).toMatch(/^evt_[0-9a-f]{24}$/)
    }
  })
})

describe.skipIf(!hasTestDatabase)('writeLifecycleEvent (real Postgres)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'openvod_t_outbox' })
    await handle.exec(DDL)
  })

  afterAll(async () => {
    await handle?.close()
  })

  const readVideo = async (id: string) => {
    const rows = normalizeRows(
      await handle.db.execute(
        sql`SELECT status, transcode_attempt_id FROM video WHERE id = ${id}`,
      ),
    )
    return rows[0]
  }

  const readEvents = async (videoId: string) => {
    const rows = normalizeRows(
      await handle.db.execute(
        sql`SELECT id, event, payload FROM event_outbox
            WHERE organization_id = ${ORG} AND payload->>'videoId' = ${videoId}
            ORDER BY created_at`,
      ),
    )
    return rows
  }

  const readyUpdate = (videoId: string, attemptId: string) => ({
    videoId,
    assignments: [
      sql`status = 'ready'`,
      sql`updated_at = now()`,
      sql`hls_url = ${'videos/' + videoId + '/playlist.m3u8'}`,
      sql`transcode_attempt_id = NULL`,
    ],
    guards: [sql`transcode_attempt_id = ${attemptId}`],
    event: {
      organizationId: ORG,
      event: 'video.ready' as const,
      payload: { videoId, title: 'First', status: 'ready' },
    },
  })

  it('records the state change and its event together', async () => {
    const result = await writeLifecycleEvent(
      handle.db,
      readyUpdate(VIDEO_1, 'att-1'),
    )

    expect(result.applied).toBe(true)

    // Both effects are present after a single call — that is the outbox property.
    const video = await readVideo(VIDEO_1)
    expect(video?.status).toBe('ready')

    const events = await readEvents(VIDEO_1)
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('video.ready')
    expect(events[0]?.id).toBe(result.applied === true ? result.eventId : '')
  })

  it('writes no second event when the same transition is replayed', async () => {
    // A retried callback finds the row already `ready` and the attempt cleared.
    const result = await writeLifecycleEvent(
      handle.db,
      readyUpdate(VIDEO_1, 'att-1'),
    )

    expect(result).toEqual({ applied: false })
    expect(await readEvents(VIDEO_1)).toHaveLength(1)
  })

  it('writes no event when the guard rejects the attempt', async () => {
    // A superseded attempt must not produce a lifecycle event at all.
    const result = await writeLifecycleEvent(
      handle.db,
      readyUpdate(VIDEO_2, 'att-superseded'),
    )

    expect(result).toEqual({ applied: false })
    expect(await readVideo(VIDEO_2)).toMatchObject({ status: 'processing' })
    expect(await readEvents(VIDEO_2)).toHaveLength(0)
  })

  it('writes no event for a soft-deleted video', async () => {
    await handle.exec(`UPDATE video SET deleted_at = now() WHERE id = '${VIDEO_2}'`)

    const result = await writeLifecycleEvent(
      handle.db,
      readyUpdate(VIDEO_2, 'att-2'),
    )

    expect(result).toEqual({ applied: false })
    expect(await readEvents(VIDEO_2)).toHaveLength(0)
  })

  it('stores the payload as queryable jsonb, not a string', async () => {
    const rows = normalizeRows(
      await handle.db.execute(
        sql`SELECT payload->>'status' AS status, payload->>'title' AS title
            FROM event_outbox WHERE organization_id = ${ORG} AND payload->>'videoId' = ${VIDEO_1}`,
      ),
    )
    expect(rows[0]).toMatchObject({ status: 'ready', title: 'First' })
  })
})
