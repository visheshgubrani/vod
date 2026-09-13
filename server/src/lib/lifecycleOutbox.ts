/**
 * Atomic lifecycle writes: the state change and its event in one statement.
 *
 * The gap this closes:
 *
 *   video becomes `ready` -> process exits before the event is enqueued
 *   -> the transcoder retries its callback -> the row is already `ready`
 *   -> the state guard ignores the callback -> `video.ready` is never delivered
 *
 * No amount of retry logic in the dispatcher fixes that, because the event was
 * never recorded. The event has to be written by the same database operation as
 * the change it describes — an outbox.
 *
 * Shape: a guarded data-modifying CTE (see `atomicWrite.ts` for why a single
 * statement rather than a transaction). The `INSERT` selects from the CTE's
 * `RETURNING` rows, so the event exists only if the transition actually
 * happened. That also makes repeated callbacks idempotent for free: the second
 * delivery fails the guard, inserts nothing, and reports "already applied".
 *
 * The event id is generated per call and returned, so the caller can log it.
 * It is the id receivers see and is stable across every retry of that event —
 * delivery is at-least-once, and that stability is what makes receiver-side
 * deduplication possible.
 */

import { randomBytes } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { runAtomicIntent, type AtomicExecutor } from './atomicWrite'
import type { WebhookEvent } from '../utils/webhookDispatcher'

export function newEventId(): string {
  return `evt_${randomBytes(12).toString('hex')}`
}

export type LifecycleEvent = {
  organizationId: string
  event: WebhookEvent
  payload: Record<string, unknown>
}

export type LifecycleUpdate = {
  videoId: string
  /** `SET` fragments, e.g. ``sql`status = 'ready'` ``. Values must be bound. */
  assignments: SQL[]
  /**
   * Extra `WHERE` conjuncts. The id and `deleted_at IS NULL` are always added
   * here, so a deleted row can never receive a lifecycle transition.
   */
  guards?: SQL[]
  event: LifecycleEvent
}

/**
 * Build the CTE. Exported so tests can assert the guard structure directly and
 * so callers can explain a rejection without re-deriving the rules.
 */
export function buildLifecycleStatement(update: LifecycleUpdate, eventId: string): SQL {
  const setClause = sql.join(update.assignments, sql`, `)

  const extraGuards = update.guards ?? []
  const guardClause = extraGuards.length
    ? sql.join(
        [sql`AND deleted_at IS NULL`, ...extraGuards.map((guard) => sql`AND ${guard}`)],
        sql` `,
      )
    : sql`AND deleted_at IS NULL`

  return sql`
    WITH updated AS (
      UPDATE video
      SET ${setClause}
      WHERE id = ${update.videoId} ${guardClause}
      RETURNING id
    )
    INSERT INTO event_outbox (id, organization_id, event, payload)
    SELECT ${eventId},
           ${update.event.organizationId},
           ${update.event.event},
           ${JSON.stringify(update.event.payload)}::jsonb
    FROM updated
    RETURNING id
  `
}

export type LifecycleWriteResult =
  | { applied: true; eventId: string }
  | { applied: false }

/**
 * Apply a video lifecycle update and record its event atomically.
 *
 * `applied: false` means the guard did not match — a duplicate or superseded
 * callback, a deleted video, or a transition that a concurrent writer already
 * performed. In every case the event was NOT recorded, which is the correct
 * outcome: there is no state change to announce.
 */
export async function writeLifecycleEvent(
  executor: AtomicExecutor,
  update: LifecycleUpdate,
): Promise<LifecycleWriteResult> {
  const eventId = newEventId()
  const outcome = await runAtomicIntent(executor, buildLifecycleStatement(update, eventId))
  return outcome.applied ? { applied: true, eventId } : { applied: false }
}
