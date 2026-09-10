/**
 * Atomic intent writes.
 *
 * The rule this module exists to enforce: **every state change that implies
 * work must persist that work in the same database operation as the change.**
 * Otherwise a crash between the two loses the work forever — a video that is
 * `ready` with no readiness event, or a row that is deleted with no cleanup
 * queued and no record that cleanup is owed.
 *
 * Why one statement instead of a transaction:
 *
 * - `neon-http` (the default Workers driver) throws on interactive
 *   transactions: `drizzle-orm/neon-http/session.js` — "No transactions support
 *   in neon-http driver". Its `.d.ts` still declares `transaction()`, so the
 *   type checker will happily let a broken call through.
 * - `postgres-js` (Docker/Node) implements interactive transactions normally.
 * - A single statement is atomic on both, so intent writes never branch on
 *   driver and cannot silently degrade on one of them.
 *
 * The shape that makes this work is the guarded data-modifying CTE:
 *
 * ```sql
 * WITH target AS (
 *   UPDATE some_row SET state = 'done'
 *   WHERE id = $1 AND state = 'pending'     -- the guard
 *   RETURNING id
 * )
 * INSERT INTO work_queue (row_id) SELECT id FROM target RETURNING id
 * ```
 *
 * Two properties fall out of that shape, and callers depend on both:
 *
 * 1. **The dependent INSERT fires only when the guard matched.** Postgres runs
 *    the UPDATE and the INSERT in one snapshot; if the guard matches nothing,
 *    no work is queued — so a stale or duplicate caller cannot enqueue work for
 *    a transition that did not happen.
 * 2. **Zero rows is not an error.** It means the transition was already
 *    applied. That is the idempotency contract: repeated webhook delivery,
 *    repeated deletion, and repeated heartbeats all resolve to "already done"
 *    rather than a second side effect.
 *
 * If the final statement fails (constraint violation, type error), Postgres
 * rolls back the whole CTE — the guarded UPDATE included. That is the atomicity
 * guarantee acceptance test #6 pins down.
 *
 * Contract for callers: the statement **must** end in a data-modifying
 * statement with `RETURNING`, and the returned rows are what `applied` is
 * derived from. A CTE whose final statement returns nothing is indistinguishable
 * from a guard that did not match.
 */

import type { SQL } from 'drizzle-orm'

export type SqlRow = Record<string, unknown>

/**
 * The minimal surface shared by `db` and a transaction handle.
 *
 * Deliberately structural rather than a drizzle type: it keeps the primitive
 * usable from both drivers, from a transaction, and from a test double.
 */
export type AtomicExecutor = {
  execute: (query: SQL) => Promise<unknown>
}

export type AtomicOutcome<T extends SqlRow> =
  | { applied: true; rows: T[] }
  | { applied: false; rows: [] }

const notApplied = <T extends SqlRow>(): AtomicOutcome<T> => ({ applied: false, rows: [] })

/**
 * Normalize a driver result to a plain row array.
 *
 * This is the one place the two supported drivers genuinely differ:
 *
 * ```ts
 * // postgres-js — PostgresJsQueryResultHKT.type = RowList<Row[]>
 * const rows = await db.execute(sql`...`)            // -> [{ id: 1 }]
 *
 * // neon-http — NeonHttpQueryResult<T> = { rows: T[] }
 * const result = await db.execute(sql`...`)          // -> { rows: [{ id: 1 }] }
 * ```
 */
export function normalizeRows(result: unknown): SqlRow[] {
  if (Array.isArray(result)) {
    return result as SqlRow[]
  }
  if (result && typeof result === 'object') {
    const rows = (result as { rows?: unknown }).rows
    if (Array.isArray(rows)) {
      return rows as SqlRow[]
    }
  }
  return []
}

/**
 * Run a guarded CTE as a single atomic statement.
 *
 * Resolves `{ applied: true, rows }` when the guard matched (the rows are the
 * CTE's `RETURNING` output) and `{ applied: false, rows: [] }` when it did not.
 * Rejects on a genuine database error so callers cannot mistake a constraint
 * violation for an idempotent no-op.
 */
export async function runAtomicIntent<T extends SqlRow = SqlRow>(
  executor: AtomicExecutor,
  statement: SQL,
): Promise<AtomicOutcome<T>> {
  const rows = normalizeRows(await executor.execute(statement)) as T[]
  if (rows.length === 0) {
    return notApplied<T>()
  }
  return { applied: true, rows }
}

/**
 * Multi-statement atomic writes, when a CTE is the wrong shape.
 *
 * A CTE is ideal for "guarded update + dependent insert". It is a poor fit when
 * the update carries many typed fields (jsonb documents, arrays, text columns):
 * raw SQL loses drizzle's type mapping, and binding a JS `Date` through a raw
 * template is broken on the installed postgres.js (Postgres reports the
 * parameter as untyped, the driver takes its string path, and
 * `Buffer.byteLength(date)` throws `ERR_INVALID_ARG_TYPE`).
 *
 * So for those call sites we keep the typed query builder and hide the driver
 * difference here instead:
 *
 * - `neon-http` exposes `db.batch()`, which the driver implements as one
 *   `client.transaction([...])` round trip — atomic, but non-interactive.
 * - `postgres-js` exposes a real interactive `db.transaction()` and no `batch`.
 *
 * `buildQueries` receives whichever handle the driver supports, so a caller
 * writes one function and both drivers do the right thing. Drizzle query
 * builders are lazy, so building them and awaiting them later is safe.
 */
export type AtomicBatchExecutor = {
  batch?: (queries: never[]) => Promise<unknown>
  transaction?: (fn: (tx: never) => Promise<unknown>) => Promise<unknown>
}

export async function runAtomically(
  executor: AtomicBatchExecutor,
  buildQueries: (handle: never) => PromiseLike<unknown>[],
): Promise<unknown[]> {
  if (typeof executor.batch === 'function') {
    // neon-http: one HTTP transaction carrying every statement.
    const results = await executor.batch(buildQueries(executor as never) as never[])
    return Array.isArray(results) ? results : []
  }

  if (typeof executor.transaction === 'function') {
    // postgres-js: interactive transaction; sequential awaits, one commit.
    return (await executor.transaction(async (tx: never) => {
      const results: unknown[] = []
      for (const query of buildQueries(tx)) {
        results.push(await query)
      }
      return results
    })) as unknown[]
  }

  throw new Error(
    'database driver exposes neither batch() nor transaction(); ' +
      'refusing to run a multi-statement write non-atomically',
  )
}

/** Does this database handle support an atomic multi-statement write? */
export function supportsAtomicBatch(executor: unknown): boolean {
  if (!executor || typeof executor !== 'object') return false
  const candidate = executor as AtomicBatchExecutor
  return typeof candidate.batch === 'function' || typeof candidate.transaction === 'function'
}
