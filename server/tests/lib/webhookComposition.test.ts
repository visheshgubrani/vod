import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { normalizeRows } from '../../src/lib/atomicWrite'
import { DEFAULT_WEBHOOK_RETRY } from '../../src/lib/retryPolicy'
import {
  createTestDb,
  hasTestDatabase,
  testDatabaseUrl,
  type TestDbHandle,
} from '../helpers/db'

/**
 * Webhook composition — the acceptance matrix.
 *
 * Everything below runs through the real pieces: the real callback route, the
 * real outbox write, the real drain, and a real HMAC signature. Only the
 * receiver's HTTP endpoint is faked, because a test cannot host one.
 *
 * The route talks to the module-level `db` proxy, which reads DATABASE_URL and
 * DB_DRIVER. Both are pointed at the test database before the route is
 * imported, so the route and the assertions share one connection target.
 */

const ORG = 'org-compose'
const VIDEO = 'cccccccc-1111-4111-8111-cccccccccccc'
const ENDPOINT = 'whep_compose'
const SECRET = 'whsec_compose_secret'
const INGEST_SECRET = 'ingest-secret-for-tests'
const ATTEMPT = 'att-compose-1'

// Must point at THIS suite's database, not the shared base URL: the route and
// the drain talk to the module-level `db` proxy, and pointing them at a shared
// database would put other suites' rows in reach of this suite's assertions.
const SUITE_DATABASE = 'openvod_t_composition'
process.env.DATABASE_URL = testDatabaseUrl(SUITE_DATABASE)
process.env.DB_DRIVER = 'pg'
process.env.MODAL_WEBHOOK_SECRET = INGEST_SECRET

/** Receiver stub that records every request it is asked to make. */
function makeReceiver(status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: string }> = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: String(init?.body ?? '') })
    return new Response('{}', { status })
  })
  return { calls, impl }
}

let received: Array<{ url: string; init: RequestInit; body: string }> = []
let nextStatus = 200

// Installed before the route module is imported so the drain picks it up.
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    received.push({ url: String(url), init: init ?? {}, body: String(init?.body ?? '') })
    return new Response('{}', { status: nextStatus })
  }),
)

const DDL = `
  DELETE FROM webhook_delivery wd USING event_outbox e
    WHERE wd.event_id = e.id AND e.organization_id = '${ORG}';
  DELETE FROM event_outbox  WHERE organization_id = '${ORG}';
  DELETE FROM webhook_endpoint WHERE organization_id = '${ORG}';
  DELETE FROM video WHERE organization_id = '${ORG}';
  DELETE FROM organization WHERE id = '${ORG}';

  INSERT INTO organization (id, name, slug, created_at)
  VALUES ('${ORG}', 'Compose', 'compose-org', now());

  INSERT INTO webhook_endpoint (id, organization_id, url, secret, events, enabled)
  VALUES ('${ENDPOINT}', '${ORG}', 'https://receiver.test/hook', '${SECRET}',
          ARRAY['video.ready']::text[], true);
`

function resetVideo(status = 'processing', attempt: string | null = ATTEMPT) {
  return `
    DELETE FROM video WHERE id = '${VIDEO}';
    INSERT INTO video (id, organization_id, title, status, transcode_attempt_id)
    VALUES ('${VIDEO}', '${ORG}', 'Compose video', '${status}', ${attempt ? `'${attempt}'` : 'NULL'});
  `
}

describe.skipIf(!hasTestDatabase)('webhook composition (real route, real DB)', () => {
  let handle: TestDbHandle
  let route: { request: (path: string, init?: RequestInit, env?: unknown, ctx?: unknown) => Promise<Response> }

  /**
   * Bring the suite to a known state: our own database is already isolated, but
   * each TEST must also be independent of its neighbours. Running a single test
   * in isolation previously failed on state an earlier test created.
   */
  const givenDeliveredEvent = async (options: { deliver?: boolean } = {}) => {
    await resetOrg()
    await handle.exec(resetVideo())
    nextStatus = options.deliver === false ? 503 : 200
    received = []
    const response = await postCallback(successCallback())
    expect(response.status).toBe(200)
    return String((await readEvents())[0]?.id)
  }

  beforeAll(async () => {
    handle = await createTestDb({ database: 'openvod_t_composition' })
    await handle.exec(DDL)
    const mod = await import('../../src/routes/webhook')
    route = mod.default as unknown as typeof route
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await handle?.close()
  })

  /** A stub ExecutionContext so `waitUntil` work can be awaited deterministically. */
  const postCallback = async (body: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = []
    const ctx = {
      waitUntil: (task: Promise<unknown>) => {
        pending.push(task)
      },
      passThroughOnException: () => {},
    }
    const response = await route.request(
      '/transcode-complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': INGEST_SECRET,
        },
        body: JSON.stringify(body),
      },
      {},
      ctx,
    )
    await Promise.allSettled(pending)
    return response
  }

  /**
   * Clear this suite's own events and deliveries.
   *
   * Count assertions must not depend on what a previous run left behind, or on
   * whether another suite's global drain touched these rows first. `beforeAll`
   * alone was not enough: a leftover row made row 1 flaky.
   */
  const resetOrg = async () => {
    await handle.exec(`
      DELETE FROM webhook_delivery WHERE event_id IN (
        SELECT id FROM event_outbox WHERE organization_id = '${ORG}'
      );
      DELETE FROM event_outbox WHERE organization_id = '${ORG}';
    `)
    // Verify rather than assume. A silently-incomplete reset used to surface as
    // a confusing "expected 1, got 3" count mismatch much later in the test.
    const remaining = normalizeRows(
      await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM event_outbox WHERE organization_id = ${ORG}`,
      ),
    )
    expect(Number(remaining[0]?.n)).toBe(0)
  }

  const readEvents = async () =>
    normalizeRows(
      await handle.db.execute(
        sql`SELECT id, event, status FROM event_outbox
            WHERE organization_id = ${ORG} ORDER BY created_at`,
      ),
    )

  const readDeliveries = async () =>
    normalizeRows(
      await handle.db.execute(
        sql`SELECT wd.id, wd.event_id, wd.endpoint_id, wd.status, wd.attempts,
                   wd.response_status
            FROM webhook_delivery wd
            JOIN event_outbox e ON e.id = wd.event_id
            WHERE e.organization_id = ${ORG}
            ORDER BY wd.created_at`,
      ),
    )

  const successCallback = () => ({
    video_id: VIDEO,
    fileId: VIDEO,
    status: 'success',
    attempt_id: ATTEMPT,
    outputs: { hls_playlist: 'videos/x/playlist.m3u8', poster: 'videos/x/poster.jpg' },
    metadata: { duration: 12, width: 1920, height: 1080 },
    processing: { transcode_time: 5 },
  })

  beforeAll(async () => {
    received = []
    nextStatus = 200
  })

  it('row 1: real callback produces one event and one signed delivery', async () => {
    await resetOrg()
    await handle.exec(resetVideo())
    received = []
    nextStatus = 200

    const response = await postCallback(successCallback())
    expect(response.status).toBe(200)

    const events = await readEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('video.ready')

    const deliveries = await readDeliveries()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.status).toBe('delivered')

    // The receiver saw a request whose HMAC matches the documented scheme.
    expect(received).toHaveLength(1)
    const sent = received[0]!
    const headers = sent.init.headers as Record<string, string>
    expect(headers['X-Webhook-Id']).toBe(String(events[0]?.id))
    expect(headers['X-Webhook-Event']).toBe('video.ready')

    const { createHmac } = await import('node:crypto')
    const expected = createHmac('sha256', SECRET)
      .update(`${headers['X-Webhook-Timestamp']}.${sent.body}`)
      .digest('hex')
    expect(headers['X-Webhook-Signature']).toBe(`sha256=${expected}`)

    // And the body is the event, not an envelope that lost the payload.
    expect(JSON.parse(sent.body).data.videoId).toBe(VIDEO)
  })

  it('row 2: a repeated callback adds no second event or delivery', async () => {
    await givenDeliveredEvent()
    const response = await postCallback(successCallback())
    expect(response.status).toBe(200)

    expect(await readEvents()).toHaveLength(1)
    expect(await readDeliveries()).toHaveLength(1)
  })

  it('row 3: a second claim cannot take a delivery whose lease is live', async () => {
    await givenDeliveredEvent()
    const { claimDueDeliveries } = await import('../../src/lib/webhookDelivery')

    await handle.exec(`
      UPDATE webhook_delivery
      SET status='pending', attempts=0, next_attempt_at=NULL,
          lease_owner='wkr_first', lease_expires_at=now() + interval '5 minutes'
        WHERE event_id IN (SELECT id FROM event_outbox WHERE organization_id = '${ORG}')
`)

    const deps = {
      executor: handle.db as never,
      fetchImpl: fetch,
      now: () => new Date(),
      leaseMs: 60_000,
      policy: DEFAULT_WEBHOOK_RETRY,
      concurrency: 4,
    }

    expect(await claimDueDeliveries(10, deps)).toHaveLength(0)
  })

  it('row 4: an unavailable receiver recovers on retry with the same event id', async () => {
    await handle.exec(resetVideo())
    await resetOrg()

    // Receiver is down for the first attempt.
    received = []
    nextStatus = 503

    await postCallback(successCallback())

    const eventId = String((await readEvents())[0]?.id)
    let deliveries = await readDeliveries()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.status).toBe('pending')
    expect(deliveries[0]?.response_status).toBe(503)

    // Receiver comes back, and the scheduled pass delivers the same event.
    nextStatus = 200
    await handle.exec(`UPDATE webhook_delivery SET next_attempt_at = now() - interval '1 minute' WHERE event_id IN (SELECT id FROM event_outbox WHERE organization_id = '${ORG}')`)

    const { drainOutbox } = await import('../../src/lib/webhookDelivery')
    const stats = await drainOutbox(
      {},
      {
        executor: handle.db as never,
        fetchImpl: fetch,
        now: () => new Date(),
        leaseMs: 60_000,
        policy: DEFAULT_WEBHOOK_RETRY,
        concurrency: 4,
      },
    )
    expect(stats.delivered).toBe(1)

    deliveries = await readDeliveries()
    expect(deliveries[0]?.status).toBe('delivered')

    // Same event id on the retry — that is what lets a receiver deduplicate.
    const retryHeaders = received.at(-1)!.init.headers as Record<string, string>
    expect(retryHeaders['X-Webhook-Id']).toBe(eventId)
  })

  it('row 5: a lost response is retried, and the retry keeps the same event id', async () => {
    // The receiver committed, then the connection died before we could read the
    // response. Our side cannot tell that from "never arrived", so it must
    // retry — and the receiver deduplicates on the stable event id.
    await givenDeliveredEvent()
    await handle.exec(`
      UPDATE webhook_delivery
      SET status='pending', attempts=1, next_attempt_at=now() - interval '1 minute',
          lease_owner=NULL, lease_expires_at=NULL
        WHERE event_id IN (SELECT id FROM event_outbox WHERE organization_id = '${ORG}')
`)
    const before = await readDeliveries()

    const flakyFetch = vi.fn(async () => {
      // The request reached the receiver; only the response was lost.
      throw new TypeError('socket hang up')
    }) as unknown as typeof fetch

    const { drainOutbox } = await import('../../src/lib/webhookDelivery')
    const stats = await drainOutbox(
      {},
      {
        executor: handle.db as never,
        fetchImpl: flakyFetch,
        now: () => new Date(),
        leaseMs: 60_000,
        policy: DEFAULT_WEBHOOK_RETRY,
        concurrency: 4,
      },
    )

    // Exactly one retry was scheduled and nothing was marked delivered.
    expect(stats.retried).toBe(1)
    expect(stats.delivered).toBe(0)

    const after = await readDeliveries()
    expect(Number(after[0]?.attempts)).toBe(Number(before[0]?.attempts) + 1)
    expect(after[0]?.status).toBe('pending')
    expect(String(after[0]?.event_id)).toBe(String(before[0]?.event_id))

    // And the retry genuinely goes out once the receiver recovers, still
    // carrying that same id.
    received = []
    nextStatus = 200
    await handle.exec(`UPDATE webhook_delivery SET next_attempt_at = now() - interval '1 minute' WHERE event_id IN (SELECT id FROM event_outbox WHERE organization_id = '${ORG}')`)
    const recovered = await drainOutbox(
      {},
      {
        executor: handle.db as never,
        fetchImpl: fetch,
        now: () => new Date(),
        leaseMs: 60_000,
        policy: DEFAULT_WEBHOOK_RETRY,
        concurrency: 4,
      },
    )
    expect(recovered.delivered).toBe(1)
    const headers = received.at(-1)!.init.headers as Record<string, string>
    expect(headers['X-Webhook-Id']).toBe(String(before[0]?.event_id))
  })

  it('row 6: a runner that dies on its final attempt leaves visible, recoverable state', async () => {
    await givenDeliveredEvent()
    // Simulate: attempts spent, lease expired, no runner left to finalize.
    await handle.exec(`
      UPDATE webhook_delivery
      SET status='pending', attempts=${DEFAULT_WEBHOOK_RETRY.maxAttempts},
          next_attempt_at=NULL, lease_owner='wkr_dead',
          lease_expires_at=now() - interval '1 minute'
        WHERE event_id IN (SELECT id FROM event_outbox WHERE organization_id = '${ORG}')
`)

    const { reclaimExhaustedDeliveries, claimDueDeliveries } = await import(
      '../../src/lib/webhookDelivery'
    )
    const deps = {
      executor: handle.db as never,
      fetchImpl: fetch,
      now: () => new Date(),
      leaseMs: 60_000,
      policy: DEFAULT_WEBHOOK_RETRY,
      concurrency: 4,
    }

    // It is not silently unpickable: it is not claimable AND it is settled.
    expect(await claimDueDeliveries(10, deps)).toHaveLength(0)
    expect(await reclaimExhaustedDeliveries(deps)).toBe(1)

    const rows = await readDeliveries()
    expect(rows[0]?.status).toBe('failed')
    expect(String(rows[0]?.status)).not.toBe('pending')
  })

  it('row 7: sends begin under a live lease, and none can finalize under an expired one', async () => {
    await givenDeliveredEvent()
    await handle.exec(`
      UPDATE webhook_delivery
      SET status='pending', attempts=1, next_attempt_at=now() - interval '1 minute',
          lease_owner=NULL, lease_expires_at=NULL
        WHERE event_id IN (SELECT id FROM event_outbox WHERE organization_id = '${ORG}')
`)

    // (a) Bounded concurrency: work is claimed one wave at a time, so every send
    // begins promptly after its claim rather than queueing behind a whole batch.
    let sendsInFlight = 0
    let maxConcurrentSends = 0
    const slowFetch = vi.fn(async () => {
      sendsInFlight += 1
      maxConcurrentSends = Math.max(maxConcurrentSends, sendsInFlight)
      await new Promise((r) => setTimeout(r, 30))
      sendsInFlight -= 1
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const { sendDueDeliveries } = await import('../../src/lib/webhookDelivery')
    await sendDueDeliveries(10, {
      executor: handle.db as never,
      fetchImpl: slowFetch,
      now: () => new Date(),
      leaseMs: 60_000,
      policy: DEFAULT_WEBHOOK_RETRY,
      concurrency: 2,
    })
    expect(maxConcurrentSends).toBeLessThanOrEqual(2)
    expect((await readDeliveries())[0]?.status).toBe('delivered')

    // (b) A send that outlives its lease must not finalize. Use a 1ms lease so
    // it expires during the send, and a receiver slower than that. `limit: 1`
    // keeps this to a single attempt so the assertion isolates the lease rule
    // rather than the exhaustion path.
    await handle.exec(`
      UPDATE webhook_delivery
      SET status='pending', attempts=1, next_attempt_at=now() - interval '1 minute',
          lease_owner=NULL, lease_expires_at=NULL, response_status=NULL, last_error=NULL
        WHERE event_id IN (SELECT id FROM event_outbox WHERE organization_id = '${ORG}')
`)
    const verySlowFetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 60))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await sendDueDeliveries(1, {
      executor: handle.db as never,
      fetchImpl: verySlowFetch,
      now: () => new Date(),
      leaseMs: 1,
      policy: DEFAULT_WEBHOOK_RETRY,
      concurrency: 1,
    })

    // The receiver said 200, but the runner no longer owned the row when it
    // tried to record that — so the write was refused. No success is recorded
    // under an expired lease; the row is reclaimed and re-sent later.
    // At-least-once, never a silent success.
    const row = (await readDeliveries())[0]
    expect(row?.status).toBe('pending')
    expect(row?.response_status).toBeNull()

    // And it genuinely is recoverable, not stuck: the next pass can claim it.
    const { claimDueDeliveries } = await import('../../src/lib/webhookDelivery')
    const reclaimed = await claimDueDeliveries(10, {
      executor: handle.db as never,
      fetchImpl: fetch,
      now: () => new Date(),
      leaseMs: 60_000,
      policy: DEFAULT_WEBHOOK_RETRY,
      concurrency: 4,
    })
    expect(reclaimed).toHaveLength(1)
  })
})
