/**
 * Atomic intent writes.
 *
 * The rule this module exists to enforce: **every state change that implies
 * work must persist that work in the same database operation as the change.**
 * Otherwise a crash between the two loses the work forever — a video that is
 * `ready` with no readiness event, or a row that is deleted with no cleanup
 * queued and no record that cleanup is owed.
 *
 * Guarded data-modifying CTEs stay the preferred shape for "update + dependent
 * insert": Postgres runs the whole statement in one snapshot, so a guard that
 * matches nothing queues no work, and a failure in the final INSERT rolls the
 * UPDATE back with it.
 *
 * Multi-statement writes that cannot be a CTE (typed jsonb/array updates) run
 * inside a postgres-js interactive transaction.
 */

import type { SQL } from 'drizzle-orm'

export type SqlRow = Record<string, unknown>

/**
 * The minimal surface shared by `db` and a transaction handle.
 *
 * Deliberately structural rather than a drizzle type: it keeps the primitive
 * usable from the real client, from a transaction, and from a test double.
 */
export type AtomicExecutor = {
  execute: (query: SQL) => Promise<unknown>
}

export type AtomicOutcome<T extends SqlRow> =
  | { applied: true; rows: T[] }
  | { applied: false; rows: [] }

const notApplied = <T extends SqlRow>(): AtomicOutcome<T> => ({ applied: false, rows: [] })

/**
 * Normalize a postgres-js Drizzle result to a plain row array.
 *
 * `db.execute()` returns a row list. A wrapped `{ rows }` object is treated as
 * empty-of-interest only when it is not an array — tests and a few call sites
 * still pass raw driver output.
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
 * `buildQueries` receives the transaction handle, so a caller writes one
 * function and postgres-js commits it as a single transaction. Drizzle query
 * builders are lazy, so building them and awaiting them later is safe.
 */
export type AtomicBatchExecutor = {
  transaction?: (fn: (tx: never) => Promise<unknown>) => Promise<unknown>
}

export async function runAtomically(
  executor: AtomicBatchExecutor,
  buildQueries: (handle: never) => PromiseLike<unknown>[],
): Promise<unknown[]> {
  if (typeof executor.transaction === 'function') {
    return (await executor.transaction(async (tx: never) => {
      const results: unknown[] = []
      for (const query of buildQueries(tx)) {
        results.push(await query)
      }
      return results
    })) as unknown[]
  }

  throw new Error(
    'database driver exposes no transaction(); refusing to run a multi-statement ' +
      'write non-atomically',
  )
}

/** Does this database handle support an atomic multi-statement write? */
export function supportsAtomicBatch(executor: unknown): boolean {
  if (!executor || typeof executor !== 'object') return false
  const candidate = executor as AtomicBatchExecutor
  return typeof candidate.transaction === 'function'
}
