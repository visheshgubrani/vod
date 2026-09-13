import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  attemptDelivery,
  claimDueDeliveries,
  claimOutboxEvents,
  drainOutbox,
  fanOutEvent,
} from '../../src/lib/webhookDelivery'
import { normalizeRows } from '../../src/lib/atomicWrite'
import { DEFAULT_WEBHOOK_RETRY } from '../../src/lib/retryPolicy'
import { connectTestDb, createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'

/**
 * Outbox drain and webhook delivery, against real Postgres.
 *
 * The interesting properties are storage-level — `FOR UPDATE SKIP LOCKED`,
 * lease ownership, `ON CONFLICT` fan-out idempotency — so fakes cannot
 * establish them. Only `fetch` is faked.
 */

const ORG = 'org-delivery'
const EVENT_1 = 'evt_000000000000000000000001'
const EVENT_2 = 'evt_000000000000000000000002'
const EVENT_3 = 'evt_000000000000000000000003'
const ENDPOINT_READY = 'whep_delivery_ready'
const ENDPOINT_ALL = 'whep_delivery_all'

const DDL = `
  DELETE FROM webhook_delivery wd USING event_outbox e
    WHERE wd.event_id = e.id AND e.organization_id = '${ORG}';
  DELETE FROM event_outbox WHERE organization_id = '${ORG}';
  DELETE FROM webhook_endpoint WHERE organization_id = '${ORG}';
  DELETE FROM organization WHERE id = '${ORG}';

  INSERT INTO organization (id, name, slug, created_at)
  VALUES ('${ORG}', 'Delivery', 'delivery-org', now());

  INSERT INTO webhook_endpoint (id, organization_id, url, secret, events, enabled) VALUES
    ('${ENDPOINT_READY}', '${ORG}', 'https://receiver.test/ready', 'whsec_ready',
     ARRAY['video.ready']::text[], true),
    ('${ENDPOINT_ALL}', '${ORG}', 'https://receiver.test/all', 'whsec_all',
     ARRAY['video.ready','video.failed']::text[], true);
`

describe.skipIf(!hasTestDatabase)('outbox drain and delivery (real Postgres)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'openvod_t_delivery' })
    await handle.exec(DDL)
  })

  afterAll(async () => {
    await handle?.close()
  })

  /** Real database, fake network. */
  const deps = (overrides: Record<string, unknown> = {}) => ({
    executor: handle.db as never,
    fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    now: () => new Date('2026-06-01T00:00:00Z'),
    leaseMs: 60_000,
    policy: DEFAULT_WEBHOOK_RETRY,
    concurrency: 4,
    ...overrides,
  })

  const seedEvent = async (id: string, event = 'video.ready') => {
    // A seed is a clean slate: the outbox row AND its deliveries. Re-seeding
    // without clearing deliveries would leave rows already `delivered`, so the
    // next drain would find nothing due and the test would pass vacuously.
    await handle.exec(`DELETE FROM webhook_delivery WHERE event_id = '${id}'`)
    await handle.exec(`
      INSERT INTO event_outbox (id, organization_id, event, payload)
      VALUES ('${id}', '${ORG}', '${event}', '{"videoId":"vid-x","title":"T"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET status = 'pending', attempts = 0,
        next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL
    `)
  }

  const readDeliveries = async (eventId: string) =>
    normalizeRows(
      await handle.db.execute(
        sql`SELECT id, endpoint_id, status, attempts, response_status, next_attempt_at, last_error
            FROM webhook_delivery WHERE event_id = ${eventId} ORDER BY endpoint_id`,
      ),
    )

  const readEvent = async (id: string) =>
    normalizeRows(
      await handle.db.execute(
        sql`SELECT id, status, dispatched_at FROM event_outbox WHERE id = ${id}`,
      ),
    )[0]

  it('fans one event out to exactly the endpoints subscribed to it', async () => {
    await seedEvent(EVENT_1)

    const [claimed] = await claimOutboxEvents(10, deps(), [EVENT_1])
    expect(claimed?.id).toBe(EVENT_1)

    const { queued } = await fanOutEvent(claimed!, deps())
    // Both seeded endpoints subscribe to video.ready; an unsubscribed third
    // would change this count.
    expect(queued).toBe(2)

    const deliveries = await readDeliveries(EVENT_1)
    expect(deliveries.map((d) => d.endpoint_id)).toEqual([ENDPOINT_ALL, ENDPOINT_READY])
    expect((await readEvent(EVENT_1))?.status).toBe('dispatched')
  })

  it('does not queue a second delivery per endpoint when the fan-out replays', async () => {
    await handle.exec(
      `UPDATE event_outbox SET status='pending', lease_owner=NULL WHERE id='${EVENT_1}'`,
    )
    const [claimed] = await claimOutboxEvents(10, deps(), [EVENT_1])
    const { queued } = await fanOutEvent(claimed!, deps())

    expect(queued).toBe(0)
    expect(await readDeliveries(EVENT_1)).toHaveLength(2)
  })

  it('delivers and records the attempt count', async () => {
    const stats = await drainOutbox({ eventIds: [EVENT_1] }, deps())
    expect(stats.delivered).toBe(2)

    for (const delivery of await readDeliveries(EVENT_1)) {
      expect(delivery.status).toBe('delivered')
      expect(delivery.attempts).toBe(1)
      expect(delivery.response_status).toBe(200)
    }
  })

  it('sends the stable event id so receivers can deduplicate', async () => {
    await seedEvent(EVENT_2)
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch

    await drainOutbox({ eventIds: [EVENT_2] }, deps({ fetchImpl }))

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const headers = (call?.[1] as RequestInit).headers as Record<string, string>
    expect(headers['X-Webhook-Id']).toBe(EVENT_2)
    expect(headers['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('schedules a backoff retry on a 500 rather than dropping the event', async () => {
    await seedEvent(EVENT_2)
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch

    const stats = await drainOutbox({ eventIds: [EVENT_2] }, deps({ fetchImpl }))
    expect(stats.retried).toBe(2)
    expect(stats.failed).toBe(0)

    for (const delivery of await readDeliveries(EVENT_2)) {
      expect(delivery.status).toBe('pending')
      expect(delivery.response_status).toBe(500)
      expect(delivery.next_attempt_at).not.toBeNull()
    }
  })

  it('gives up immediately on a non-retryable 422', async () => {
    await seedEvent(EVENT_3)
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 422 }),
    ) as unknown as typeof fetch

    const stats = await drainOutbox({ eventIds: [EVENT_3] }, deps({ fetchImpl }))
    expect(stats.failed).toBe(2)

    for (const delivery of await readDeliveries(EVENT_3)) {
      expect(delivery.status).toBe('failed')
      expect(String(delivery.last_error)).toContain('HTTP 422')
    }
  })

  it('lets only one of two concurrent claimers take the same event', async () => {
    await seedEvent(EVENT_1)
    const racer = await connectTestDb({ database: 'openvod_t_delivery' })

    try {
      const [a, b] = await Promise.all([
        claimOutboxEvents(1, deps(), [EVENT_1]),
        claimOutboxEvents(1, deps({ executor: racer.db }), [EVENT_1]),
      ])

      expect([...a, ...b].map((row) => row.id)).toEqual([EVENT_1])
    } finally {
      await racer.close()
    }
  })

  it('refuses to finalize a delivery whose lease it does not hold', async () => {
    await handle.exec(
      `UPDATE video SET status='ready' WHERE false;
       UPDATE event_outbox SET status='pending', lease_owner=NULL WHERE id='${EVENT_1}'`,
    )
    await drainOutbox({ eventIds: [EVENT_1] }, deps())

    // A live row owned by somebody else.
    await handle.exec(`
      UPDATE webhook_delivery
      SET status='pending', attempts=0, next_attempt_at=NULL,
          lease_owner='wkr_someone_else',
          lease_expires_at=now() + interval '10 minutes'
      WHERE event_id='${EVENT_1}'
    `)

    const rows = normalizeRows(
      await handle.db.execute(
        sql`SELECT id, url, secret FROM webhook_delivery WHERE event_id = ${EVENT_1} LIMIT 1`,
      ),
    )
    const stale = {
      id: String(rows[0]!.id),
      eventId: EVENT_1,
      url: String(rows[0]!.url),
      secret: String(rows[0]!.secret),
      attempts: 1,
      event: 'video.ready',
      payload: {},
      // A lease this runner does not hold.
      leaseOwner: 'wkr_not_the_owner',
    }

    expect((await attemptDelivery(stale, deps())).outcome).toBe('delivered')

    // The guarded UPDATE matched nothing, so the real owner's row is untouched.
    const target = (await readDeliveries(EVENT_1)).find((row) => row.id === stale.id)
    expect(target?.status).toBe('pending')
    expect(target?.attempts).toBe(0)
  })

  it('claims nothing while a delivery is not yet due', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    await handle.exec(
      `UPDATE webhook_delivery SET next_attempt_at = '${future}' WHERE event_id='${EVENT_1}'`,
    )

    const claimed = await claimDueDeliveries(10, deps())
    expect(claimed.filter((row) => row.eventId === EVENT_1)).toHaveLength(0)
  })
})
