import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestDb,
  hasTestDatabase,
  testDatabaseUrl,
  type TestDbHandle,
} from '../helpers/db'
import { createTestRuntime, withRuntime } from '../helpers/runtime'

/**
 * POST /api/webhook/heartbeat — the write coalescing guard.
 *
 * Why this suite exists. The transcoder reports progress once a second per
 * encoder and a ladder encodes its renditions concurrently, so a four-way job
 * posted four heartbeats a second. Every one of them was a 200 and a database
 * write whose only effect was to move `last_heartbeat_at` forward by less than a
 * second against a 20-minute lease — thousands of writes for a ten-minute clip.
 *
 * The route now answers a beat that would write nothing new with a 200 without
 * touching the row. What must stay true, and is asserted here against a real
 * Postgres rather than a SQL substring:
 *
 * - a beat inside the window leaves both `last_heartbeat_at` and the lease alone;
 * - a beat outside it still extends the lease (the whole point of a heartbeat);
 * - coalescing never masks the ownership and status guards, which answer
 *   `ignored` exactly as before — a superseded attempt must not be kept alive by
 *   a guard meant to reduce load.
 */

const ORG = 'org-heartbeat'
const VIDEO = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'
const ATTEMPT = 'att-heartbeat-1'
const INGEST_SECRET = 'ingest-secret-for-heartbeat-tests'

// The route and the assertions must share one connection target, so point the
// module-level `db` proxy at this suite's database before importing the route.
process.env.DATABASE_URL = testDatabaseUrl('clipmux_t_heartbeat')
process.env.DB_DRIVER = 'pg'
process.env.MODAL_WEBHOOK_SECRET = INGEST_SECRET

const RUNTIME_ENV = { TRANSCODE_INGEST_SECRET: INGEST_SECRET }

type VideoOptions = {
  status?: string
  attempt?: string | null
  /** Seconds before now; negative is in the future. `null` means never. */
  heartbeatAgoSeconds?: number | null
  leaseSeconds?: number | null
}

function seedVideo(options: VideoOptions = {}): string {
  const {
    status = 'processing',
    attempt = ATTEMPT,
    heartbeatAgoSeconds = null,
    leaseSeconds = null,
  } = options
  const heartbeat =
    heartbeatAgoSeconds === null
      ? 'NULL'
      : `now() - (${heartbeatAgoSeconds}::text || ' seconds')::interval`
  const lease =
    leaseSeconds === null
      ? 'NULL'
      : `now() + (${leaseSeconds}::text || ' seconds')::interval`

  return `
    DELETE FROM video WHERE id = '${VIDEO}';
    INSERT INTO video (
      id, organization_id, title, status, transcode_attempt_id,
      last_heartbeat_at, transcode_lease_expires_at
    )
    VALUES (
      '${VIDEO}', '${ORG}', 'Heartbeat video', '${status}',
      ${attempt ? `'${attempt}'` : 'NULL'}, ${heartbeat}, ${lease}
    );
  `
}

type VideoRow = {
  last_heartbeat_at: string | null
  transcode_lease_expires_at: string | null
}

describe.skipIf(!hasTestDatabase)('heartbeat write coalescing (real route, real DB)', () => {
  let handle: TestDbHandle
  let route: {
    request: (
      path: string,
      init?: RequestInit,
      env?: unknown,
      ctx?: unknown,
    ) => Promise<Response>
  }

  const readVideo = async (): Promise<VideoRow> => {
    const rows = (await handle.exec(`
      SELECT last_heartbeat_at::text AS last_heartbeat_at,
             transcode_lease_expires_at::text AS transcode_lease_expires_at
      FROM video WHERE id = '${VIDEO}'
    `)) as unknown as VideoRow[]
    return rows[0]!
  }

  const postBeat = async (
    body: Record<string, unknown>,
    secret: string = INGEST_SECRET,
  ): Promise<Response> =>
    route.request('/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    handle = await createTestDb({ database: 'clipmux_t_heartbeat' })
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG}', 'Heartbeat', 'heartbeat-org', now())
      ON CONFLICT (id) DO NOTHING;
    `)
    const mod = await import('../../src/routes/webhook')
    route = withRuntime(
      mod.default,
      createTestRuntime(RUNTIME_ENV),
    ) as unknown as typeof route
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('writes the first beat a dead attempt never sent', async () => {
    await handle.exec(seedVideo({ heartbeatAgoSeconds: null, leaseSeconds: 60 }))

    const response = await postBeat({ video_id: VIDEO, attempt_id: ATTEMPT, stage: 'transcode' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    const row = await readVideo()
    expect(row.last_heartbeat_at).not.toBeNull()
  })

  it('extends the lease by the documented window', async () => {
    await handle.exec(seedVideo({ heartbeatAgoSeconds: 60, leaseSeconds: 60 }))

    await postBeat({ video_id: VIDEO, attempt_id: ATTEMPT, stage: 'transcode' })

    const rows = (await handle.exec(`
      SELECT EXTRACT(EPOCH FROM (transcode_lease_expires_at - now()))::int AS seconds
      FROM video WHERE id = '${VIDEO}'
    `)) as unknown as Array<{ seconds: number }>
    // DEFAULT_TRANSCODE_LEASE_MS is 20 minutes; allow for the round trip.
    expect(rows[0]!.seconds).toBeGreaterThan(20 * 60 - 60)
    expect(rows[0]!.seconds).toBeLessThanOrEqual(20 * 60)
  })

  it('coalesces a beat that arrives inside the window', async () => {
    // The 1 Hz case: the row was beaten one second ago.
    await handle.exec(seedVideo({ heartbeatAgoSeconds: 1, leaseSeconds: 1200 }))
    const before = await readVideo()

    const response = await postBeat({ video_id: VIDEO, attempt_id: ATTEMPT, stage: 'transcode' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, throttled: true })
    const after = await readVideo()
    expect(after.last_heartbeat_at).toBe(before.last_heartbeat_at)
    expect(after.transcode_lease_expires_at).toBe(before.transcode_lease_expires_at)
  })

  it('still writes a beat that arrives after the window', async () => {
    // Outside HEARTBEAT_WRITE_MIN_INTERVAL_MS (10s). A guard that never expired
    // would leave long jobs looking dead to the sweeper.
    await handle.exec(seedVideo({ heartbeatAgoSeconds: 11, leaseSeconds: 1200 }))
    const before = await readVideo()

    const response = await postBeat({ video_id: VIDEO, attempt_id: ATTEMPT, stage: 'transcode' })

    expect(await response.json()).toEqual({ success: true })
    const after = await readVideo()
    expect(after.last_heartbeat_at).not.toBe(before.last_heartbeat_at)
  })

  it('never lets coalescing mask a superseded attempt', async () => {
    // A recent heartbeat from the *live* attempt must not make the guard swallow
    // the check that rejects the superseded one — otherwise a dead attempt's
    // beat would be acknowledged as if it owned the row.
    await handle.exec(seedVideo({ heartbeatAgoSeconds: 1, leaseSeconds: 1200 }))
    const before = await readVideo()

    const response = await postBeat({ video_id: VIDEO, attempt_id: 'att-superseded' })

    expect(await response.json()).toEqual({ success: true, ignored: true })
    expect((await readVideo()).last_heartbeat_at).toBe(before.last_heartbeat_at)
  })

  it('never lets a coalesced beat write to a video that already finished', async () => {
    // Ordering here is deliberate: coalescing is checked *before* the status
    // guard's UPDATE, so a beat that finds a recent `last_heartbeat_at` answers
    // `throttled` even when the row is terminal. What matters is asserted below —
    // nothing is written, and the transcoder is acknowledged.
    await handle.exec(
      seedVideo({ status: 'ready', heartbeatAgoSeconds: 1, leaseSeconds: 1200 }),
    )
    const before = await readVideo()

    const response = await postBeat({ video_id: VIDEO, attempt_id: ATTEMPT })

    expect(await response.json()).toEqual({ success: true, throttled: true })
    const after = await readVideo()
    expect(after.last_heartbeat_at).toBe(before.last_heartbeat_at)
    expect(after.transcode_lease_expires_at).toBe(before.transcode_lease_expires_at)
  })

  it('answers ignored for a terminal video whose last beat has expired', async () => {
    // With no recent beat to coalesce against, the status guard is reached and
    // reports the row as it always has: a callback for a finished video is not a
    // heartbeat that landed.
    await handle.exec(seedVideo({ status: 'ready', heartbeatAgoSeconds: 600 }))
    const before = await readVideo()

    const response = await postBeat({ video_id: VIDEO, attempt_id: ATTEMPT })

    expect(await response.json()).toEqual({ success: true, ignored: true })
    expect((await readVideo()).last_heartbeat_at).toBe(before.last_heartbeat_at)
  })

  it('acknowledges an unknown video instead of failing the transcoder', async () => {
    const response = await postBeat({
      video_id: 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb',
      attempt_id: ATTEMPT,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, ignored: true })
  })

  it('rejects a beat without the shared secret', async () => {
    await handle.exec(seedVideo({ heartbeatAgoSeconds: 60 }))
    const response = await postBeat(
      { video_id: VIDEO, attempt_id: ATTEMPT },
      'not-the-secret',
    )
    expect(response.status).toBe(401)
  })

  it('requires a video id', async () => {
    const response = await postBeat({ attempt_id: ATTEMPT })
    expect(response.status).toBe(400)
  })
})
