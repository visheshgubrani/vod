/**
 * Outbox drain and webhook delivery.
 *
 * Two stages, deliberately separated:
 *
 * 1. **Drain** — take a durable `event_outbox` row and fan it out into one
 *    `webhook_delivery` row per subscribed endpoint. The outbox row is what
 *    guarantees the event exists at all; this stage is what makes it per-tenant
 *    and independently retryable.
 * 2. **Deliver** — send each due delivery, with retries.
 *
 * Both stages select work with `FOR UPDATE SKIP LOCKED` and then own it with a
 * lease, so two runners — the inline attempt and the sweeper — can run
 * concurrently without double-sending. A runner may only finalize a row whose
 * lease it still holds, which also makes a crashed runner's work recoverable
 * rather than stuck: its lease expires and the row is claimed again.
 *
 * Latency and durability come from different places. The outbox write gives
 * durability; the inline drain gives the same end-to-end latency the old direct
 * dispatch had. If the process dies between the two, the sweeper delivers late
 * rather than never — which is the entire point.
 */

import { randomBytes } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { db } from './database'
import { normalizeRows, type AtomicExecutor } from './atomicWrite'
import { generateSignature } from '../utils/webhookDispatcher'
import {
  DEFAULT_WEBHOOK_RETRY,
  decideDeliveryOutcome,
  type RetryPolicy,
} from './retryPolicy'

export type WebhookDrainDeps = {
  /** Injected for tests; defaults to the shared db handle. */
  executor: AtomicExecutor
  /** Injected for tests; defaults to global fetch. */
  fetchImpl: typeof fetch
  now: () => Date
  /** Lease duration; a runner must finish inside it or lose the row. */
  leaseMs: number
  policy: RetryPolicy
  /** Deliveries sent concurrently within one wave. */
  concurrency: number
}

export const DEFAULT_WEBHOOK_DRAIN_DEPS: WebhookDrainDeps = {
  executor: db,
  // Deliberately indirect: binding `fetch` directly would capture the global at
  // module load, so a later `vi.stubGlobal('fetch', ...)` would have no effect
  // and the end-to-end delivery path could not be tested.
  fetchImpl: ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch,
  now: () => new Date(),
  leaseMs: 60_000,
  policy: DEFAULT_WEBHOOK_RETRY,
  concurrency: 4,
}

function newLeaseOwner(): string {
  return `wkr_${randomBytes(8).toString('hex')}`
}

/** postgres-js hands back parsed jsonb; neon-http may hand back a string. */
function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * `id IN (a, b, c)` built from scalar bindings.
 *
 * Drizzle does not array-bind through a raw `sql` template: passing a JS array
 * for a `text[]` parameter sends a bare string, and Postgres rejects it with
 * "malformed array literal". Binding each element separately is portable.
 */
function buildIdFilter(ids: string[] | null | undefined, column: SQL): SQL {
  if (!ids || ids.length === 0) return sql``
  return sql`AND ${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`
}

// ────────────────────────────────────────────────────────────────────────────
// Stage 1: fan an outbox event out to subscribed endpoints
// ────────────────────────────────────────────────────────────────────────────

export type ClaimedEvent = {
  id: string
  organizationId: string
  event: string
  payload: unknown
  attempts: number
  leaseOwner: string
}

export async function claimOutboxEvents(
  limit: number,
  deps: WebhookDrainDeps = DEFAULT_WEBHOOK_DRAIN_DEPS,
  /** When set, claim only these events (the inline fast path). */
  eventIds?: string[] | null,
): Promise<ClaimedEvent[]> {
  const leaseOwner = newLeaseOwner()
  const idFilter = buildIdFilter(eventIds, sql`id`)

  const rows = normalizeRows(
    await deps.executor.execute(sql`
      UPDATE event_outbox
      SET status = 'dispatching',
          lease_owner = ${leaseOwner},
          lease_expires_at = now() + (${deps.leaseMs}::int * interval '1 millisecond'),
          attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM event_outbox
        WHERE (
                status = 'pending'
                OR (status = 'dispatching' AND lease_expires_at < now())
              )
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ${idFilter}
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organization_id, event, payload, attempts, lease_owner
    `),
  )

  return rows.map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    event: String(row.event),
    payload: row.payload,
    attempts: Number(row.attempts ?? 0),
    leaseOwner: String(row.lease_owner ?? leaseOwner),
  }))
}

/**
 * Create one delivery row per enabled, subscribed endpoint and mark the event
 * dispatched. Both happen in one statement, so an event can never be recorded
 * as dispatched with no delivery queued for it.
 *
 * The insert selects `FROM dispatched`, so it runs **only if the lease-guarded
 * update matched**. Writing the delivery rows unconditionally would mean a
 * runner that had already lost its lease still created work — harmless for
 * correctness (the unique index and `ON CONFLICT` dedupe it) but it would let a
 * stale runner mutate state it no longer owns, which is the property the lease
 * exists to provide.
 */
export async function fanOutEvent(
  event: ClaimedEvent,
  deps: WebhookDrainDeps = DEFAULT_WEBHOOK_DRAIN_DEPS,
): Promise<{ queued: number }> {
  const rows = normalizeRows(
    await deps.executor.execute(sql`
      WITH dispatched AS (
        UPDATE event_outbox
        SET status = 'dispatched',
            dispatched_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = NULL
        WHERE id = ${event.id} AND lease_owner = ${event.leaseOwner}
        RETURNING id, organization_id, event
      ), inserted AS (
        INSERT INTO webhook_delivery (id, event_id, endpoint_id, url, secret)
        SELECT 'whd_' || gen_random_uuid()::text, d.id, ep.id, ep.url, ep.secret
        FROM dispatched AS d
        JOIN webhook_endpoint AS ep
          ON ep.organization_id = d.organization_id
         AND ep.enabled = true
         AND d.event = ANY(ep.events)
        ON CONFLICT (event_id, endpoint_id) DO NOTHING
        RETURNING id
      )
      SELECT (SELECT count(*) FROM inserted)::int AS queued,
             (SELECT count(*) FROM dispatched)::int AS finalized
    `),
  )

  const row = rows[0]
  if (!row || Number(row.finalized ?? 0) === 0) {
    // Lease lost to another runner — it owns finalization now, and we have
    // deliberately queued nothing.
    throw new Error(`outbox lease lost for event ${event.id}`)
  }
  return { queued: Number(row.queued ?? 0) }
}

// ────────────────────────────────────────────────────────────────────────────
// Stage 2: deliver due rows
// ────────────────────────────────────────────────────────────────────────────

export type DueDelivery = {
  id: string
  eventId: string
  url: string
  secret: string
  attempts: number
  event: string
  payload: unknown
  leaseOwner: string
}

export async function claimDueDeliveries(
  limit: number,
  deps: WebhookDrainDeps = DEFAULT_WEBHOOK_DRAIN_DEPS,
): Promise<DueDelivery[]> {
  const leaseOwner = newLeaseOwner()

  const rows = normalizeRows(
    await deps.executor.execute(sql`
      WITH due AS (
        SELECT wd.id FROM webhook_delivery AS wd
        WHERE wd.status = 'pending'
          AND (wd.next_attempt_at IS NULL OR wd.next_attempt_at <= now())
          -- A row already owned by a live lease belongs to another runner that
          -- is sending it right now. FOR UPDATE SKIP LOCKED does NOT cover
          -- this: the row lock is released when the claiming statement commits,
          -- long before the HTTP request finishes. Without this condition a
          -- second runner claims and sends the same delivery concurrently.
          AND (wd.lease_owner IS NULL OR wd.lease_expires_at < now())
          AND wd.attempts < ${deps.policy.maxAttempts}
        ORDER BY wd.created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE webhook_delivery AS wd
        SET lease_owner = ${leaseOwner},
            lease_expires_at = now() + (${deps.leaseMs}::int * interval '1 millisecond'),
            attempts = wd.attempts + 1
        FROM due
        WHERE wd.id = due.id
        RETURNING wd.id, wd.event_id, wd.url, wd.secret, wd.attempts, wd.lease_owner
      )
      SELECT c.id, c.event_id, c.url, c.secret, c.attempts, c.lease_owner,
             e.event, e.payload
      FROM claimed AS c
      JOIN event_outbox AS e ON e.id = c.event_id
    `),
  )

  return rows.map((row) => ({
    id: String(row.id),
    eventId: String(row.event_id),
    url: String(row.url),
    secret: String(row.secret),
    attempts: Number(row.attempts ?? 1),
    event: String(row.event),
    payload: row.payload,
    leaseOwner: String(row.lease_owner ?? leaseOwner),
  }))
}

/**
 * Make a crashed runner's final-attempt row visibly terminal.
 *
 * The claim excludes rows whose `attempts` have reached the cap, so a runner
 * that dies on its last allowed attempt leaves the row `pending` with a spent
 * budget — unpickable forever, and invisible to anyone watching for failures.
 * This settles them as `failed` instead. It only touches rows whose lease is
 * absent or expired, so it can never settle a row another runner is sending.
 */
export async function reclaimExhaustedDeliveries(
  deps: WebhookDrainDeps = DEFAULT_WEBHOOK_DRAIN_DEPS,
): Promise<number> {
  const rows = normalizeRows(
    await deps.executor.execute(sql`
      UPDATE webhook_delivery
      SET status = 'failed',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = ${`attempt budget (${deps.policy.maxAttempts}) exhausted without a final result`}
      WHERE status = 'pending'
        AND attempts >= ${deps.policy.maxAttempts}
        AND (lease_owner IS NULL OR lease_expires_at < now())
      RETURNING id
    `),
  )
  return rows.length
}

export type DeliveryAttemptResult =
  | { outcome: 'delivered'; status: number }
  | { outcome: 'retry'; status: number | null; delayMs: number; error: string }
  | { outcome: 'failed'; status: number | null; error: string }

/**
 * Send one delivery and record the outcome.
 *
 * The finalize UPDATE re-asserts the lease, so a runner that stalled past its
 * lease cannot overwrite the result of the runner that took over.
 */
export async function attemptDelivery(
  delivery: DueDelivery,
  deps: WebhookDrainDeps = DEFAULT_WEBHOOK_DRAIN_DEPS,
): Promise<DeliveryAttemptResult> {
  const now = deps.now()
  const timestamp = Math.floor(now.getTime() / 1000)
  const body = JSON.stringify({
    // Stable across every retry: this is what receivers deduplicate on.
    id: delivery.eventId,
    event: delivery.event,
    timestamp: now.toISOString(),
    data: asObject(delivery.payload),
  })
  const signature = generateSignature(delivery.secret, timestamp, body)

  let status: number | null = null
  let transportError: string | null = null

  try {
    const response = await deps.fetchImpl(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': delivery.event,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Id': delivery.eventId,
        'X-Webhook-Attempt': String(delivery.attempts),
        'User-Agent': 'OpenVOD-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    status = response.status
  } catch (err) {
    transportError = err instanceof Error ? err.message : String(err)
  }

  const decision = decideDeliveryOutcome({
    attemptsMade: delivery.attempts,
    status,
    error: transportError,
    policy: deps.policy,
  })

  if (decision.kind === 'delivered') {
    await finalizeDelivery(
      delivery,
      sql`SET status = 'delivered', delivered_at = now(), response_status = ${status},
              lease_owner = NULL, lease_expires_at = NULL, last_error = NULL`,
      deps,
    )
    return { outcome: 'delivered', status: status as number }
  }

  if (decision.kind === 'retry') {
    const error = transportError ?? `HTTP ${status}`
    await finalizeDelivery(
      delivery,
      sql`SET response_status = ${status},
              next_attempt_at = now() + (${decision.delayMs}::int * interval '1 millisecond'),
              lease_owner = NULL, lease_expires_at = NULL,
              last_error = ${error}`,
      deps,
    )
    return { outcome: 'retry', status, delayMs: decision.delayMs, error }
  }

  await finalizeDelivery(
    delivery,
    sql`SET status = 'failed', response_status = ${status},
            lease_owner = NULL, lease_expires_at = NULL, last_error = ${decision.reason}`,
    deps,
  )
  return { outcome: 'failed', status, error: decision.reason }
}

async function finalizeDelivery(
  delivery: DueDelivery,
  setClause: SQL,
  deps: WebhookDrainDeps,
): Promise<void> {
  const rows = normalizeRows(
    await deps.executor.execute(sql`
      UPDATE webhook_delivery
      ${setClause}
      WHERE id = ${delivery.id}
        AND lease_owner = ${delivery.leaseOwner}
        AND lease_expires_at > now()
      RETURNING id
    `),
  )
  if (rows.length === 0) {
    // Another runner took over while this one was sending. Its result wins.
    console.warn(
      `[Webhook] delivery ${delivery.id} finalized by another runner; this result discarded`,
    )
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Entry points
// ────────────────────────────────────────────────────────────────────────────

export type DrainResult = {
  eventsDrained: number
  deliveriesQueued: number
  delivered: number
  retried: number
  failed: number
  /** Rows settled because a runner died holding their final attempt. */
  recovered: number
}

/**
 * Send whatever is due, in concurrent waves.
 *
 * The previous version claimed up to 50 deliveries with 60-second leases and
 * then sent them one at a time. With a 10-second request timeout, later
 * deliveries in the batch could have their lease expire before the first
 * attempt was even made — so the lease proved nothing about who was sending.
 *
 * Claiming exactly one wave's worth, then sending the wave concurrently, bounds
 * the gap between claiming a row and sending it to a single request timeout —
 * comfortably inside the lease. Safe to run from several runners at once.
 */
export async function sendDueDeliveries(
  limit = 50,
  deps: WebhookDrainDeps = DEFAULT_WEBHOOK_DRAIN_DEPS,
): Promise<{ delivered: number; retried: number; failed: number; recovered: number }> {
  const stats = { delivered: 0, retried: 0, failed: 0, recovered: 0 }
  // Guard the wave size rather than trusting a partially-specified deps object:
  // an undefined concurrency would become `LIMIT NaN` and fail the query.
  const concurrency =
    Number.isFinite(deps.concurrency) && deps.concurrency > 0
      ? deps.concurrency
      : DEFAULT_WEBHOOK_DRAIN_DEPS.concurrency
  const waveSize = Math.max(1, Math.min(concurrency, limit))
  let sent = 0

  while (sent < limit) {
    // Claim only what this wave can send straight away.
    const wave = await claimDueDeliveries(Math.min(waveSize, limit - sent), deps)
    if (wave.length === 0) break
    sent += wave.length

    const results = await Promise.all(
      wave.map(async (delivery) => {
        try {
          return await attemptDelivery(delivery, deps)
        } catch (err) {
          console.error(`[Webhook] delivery ${delivery.id} threw:`, err)
          return { outcome: 'failed' as const, status: null, error: String(err) }
        }
      }),
    )

    for (const result of results) {
      if (result.outcome === 'delivered') stats.delivered += 1
      else if (result.outcome === 'retry') stats.retried += 1
      else stats.failed += 1
    }
  }

  // Settle rows whose runner died holding the last allowed attempt, so they
  // surface as failures instead of sitting unpickable forever.
  stats.recovered = await reclaimExhaustedDeliveries(deps)

  return stats
}

/**
 * Fan out due events, then attempt the deliveries they produced.
 *
 * `eventIds` narrows the fan-out to one request's events so the inline path
 * does not touch unrelated backlog; omit it to drain whatever is due (sweeper).
 */
export async function drainOutbox(
  options: { eventIds?: string[]; eventLimit?: number; deliveryLimit?: number } = {},
  deps: WebhookDrainDeps = DEFAULT_WEBHOOK_DRAIN_DEPS,
): Promise<DrainResult> {
  const result: DrainResult = {
    eventsDrained: 0,
    deliveriesQueued: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    recovered: 0,
  }

  const claimed = await claimOutboxEvents(
    options.eventLimit ?? 25,
    deps,
    options.eventIds ?? null,
  )

  for (const event of claimed) {
    try {
      const { queued } = await fanOutEvent(event, deps)
      result.eventsDrained += 1
      result.deliveriesQueued += queued
    } catch (err) {
      // A lost lease is expected under concurrency; anything else is a real fault.
      console.warn(`[Outbox] fan-out skipped for ${event.id}:`, err)
    }
  }

  const sendResult = await sendDueDeliveries(options.deliveryLimit ?? 50, deps)
  result.delivered += sendResult.delivered
  result.retried += sendResult.retried
  result.failed += sendResult.failed
  result.recovered += sendResult.recovered

  return result
}
