import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'
import {
  normalizeRows,
  runAtomically,
  runAtomicIntent,
  supportsAtomicBatch,
} from '../../src/lib/atomicWrite'
import {
  createTestDb,
  hasTestDatabase,
  type TestDbHandle,
} from '../helpers/db'

// ────────────────────────────────────────────────────────────────────────────
// Result normalization.
//
// Verified against drizzle-orm 0.45.2:
//   postgres-js  PostgresJsQueryResultHKT.type = RowList<Row[]>   -> row array
//
// No database needed; these are pure shape checks.
// ────────────────────────────────────────────────────────────────────────────
describe('normalizeRows', () => {
  it('accepts the postgres-js shape (a bare row array)', () => {
    expect(normalizeRows([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('treats a driver result with no rows as an empty list', () => {
    expect(normalizeRows({ rows: [], rowCount: 0 })).toEqual([])
    expect(normalizeRows([])).toEqual([])
  })

  it('treats null/undefined as an empty list rather than throwing', () => {
    expect(normalizeRows(null)).toEqual([])
    expect(normalizeRows(undefined)).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Acceptance test 6: "Database operation fails midway: both drivers preserve
// the intended atomicity."
//
// These run against a real Postgres. A fake executor can only prove that we
// called something — it cannot prove Postgres rolled back.
//
// The probe tables are local to this suite so the test states its own
// preconditions instead of depending on the production schema.
// ────────────────────────────────────────────────────────────────────────────

const GUARD_DDL = `
  DROP TABLE IF EXISTS atomic_probe_effect;
  DROP TABLE IF EXISTS atomic_probe_guard;
  CREATE TABLE atomic_probe_guard (
    id integer PRIMARY KEY,
    applied_at timestamptz
  );
  CREATE TABLE atomic_probe_effect (
    id serial PRIMARY KEY,
    ref_id integer NOT NULL,
    required text NOT NULL
  );
  INSERT INTO atomic_probe_guard (id, applied_at) VALUES (1, NULL), (2, NULL);
`

/** Guarded CTE: the INSERT fires only when the UPDATE guard matched. */
const GUARDED_CTE = sql`
  WITH target AS (
    UPDATE atomic_probe_guard
    SET applied_at = now()
    WHERE id = 1 AND applied_at IS NULL
    RETURNING id
  )
  INSERT INTO atomic_probe_effect (ref_id, required)
  SELECT id, 'ok' FROM target
  RETURNING ref_id
`

/** Same shape, but the INSERT violates NOT NULL — the UPDATE must roll back. */
const FAILING_CTE = sql`
  WITH target AS (
    UPDATE atomic_probe_guard
    SET applied_at = now()
    WHERE id = 2 AND applied_at IS NULL
    RETURNING id
  )
  INSERT INTO atomic_probe_effect (ref_id, required)
  SELECT id, NULL FROM target
  RETURNING ref_id
`

describe.skipIf(!hasTestDatabase)('atomic intent writes (real Postgres)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'clipmux_t_atomicwrite' })
    await handle.exec(GUARD_DDL)
  })

  afterAll(async () => {
    await handle?.close()
  })

  const countEffects = async (): Promise<number> => {
    const rows = normalizeRows(
      await handle.db.execute(sql`SELECT count(*)::int AS n FROM atomic_probe_effect`),
    )
    return Number(rows[0]?.n ?? -1)
  }

  it('applies the guarded transition and its dependent insert together', async () => {
    const outcome = await runAtomicIntent<{ ref_id: number }>(handle.db, GUARDED_CTE)

    expect(outcome.applied).toBe(true)
    expect(outcome.rows).toEqual([{ ref_id: 1 }])
    expect(await countEffects()).toBe(1)
  })

  it('is idempotent: replaying the same statement neither re-applies nor inserts', async () => {
    // Establish the initial write HERE rather than relying on the previous
    // test: running this test alone previously failed, because the guard still
    // matched and the first call legitimately applied.
    await handle.exec(`UPDATE atomic_probe_guard SET applied_at = NULL WHERE id = 1`)
    await handle.exec(`DELETE FROM atomic_probe_effect`)

    const first = await runAtomicIntent<{ ref_id: number }>(handle.db, GUARDED_CTE)
    expect(first.applied).toBe(true)
    expect(await countEffects()).toBe(1)

    // Second delivery of the same intent — the guard no longer matches.
    const outcome = await runAtomicIntent<{ ref_id: number }>(handle.db, GUARDED_CTE)

    expect(outcome.applied).toBe(false)
    expect(outcome.rows).toEqual([])
    // Still exactly the one effect row from the first call, not two.
    expect(await countEffects()).toBe(1)
  })

  it('rolls the whole statement back when the dependent insert fails', async () => {
    const effectsBefore = await countEffects()

    await expect(runAtomicIntent(handle.db, FAILING_CTE)).rejects.toThrow()

    // The UPDATE in the CTE succeeded, but the statement failed — Postgres must
    // have rolled the UPDATE back with it.
    const guard = normalizeRows(
      await handle.db.execute(
        sql`SELECT applied_at FROM atomic_probe_guard WHERE id = 2`,
      ),
    )
    expect(guard).toEqual([{ applied_at: null }])
    expect(await countEffects()).toBe(effectsBefore)
  })

  it('never inserts when the guard matches nothing', async () => {
    const effectsBefore = await countEffects()

    const outcome = await runAtomicIntent(
      handle.db,
      sql`
        WITH target AS (
          UPDATE atomic_probe_guard
          SET applied_at = now()
          WHERE id = 999 AND applied_at IS NULL
          RETURNING id
        )
        INSERT INTO atomic_probe_effect (ref_id, required)
        SELECT id, 'ok' FROM target
        RETURNING ref_id
      `,
    )

    expect(outcome.applied).toBe(false)
    expect(await countEffects()).toBe(effectsBefore)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Multi-statement atomic writes (runAtomically).
//
// Needed for the lifecycle+outbox write, where a CTE is the wrong shape: the
// update carries jsonb documents and arrays, so the typed query builder has to
// stay. Multi-statement writes run inside a postgres-js transaction, and that
// interface is what is tested here.
// ────────────────────────────────────────────────────────────────────────────
describe('runAtomically', () => {
  const probe = pgTable('atomic_probe_guard', {
    id: integer('id').primaryKey(),
    appliedAt: timestamp('applied_at'),
  })
  const effect = pgTable('atomic_probe_effect', {
    id: serial('id').primaryKey(),
    refId: integer('ref_id').notNull(),
    required: text('required').notNull(),
  })

  it('routes to transaction() on postgres-js', async () => {
    const built: unknown[] = []
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: () => Promise.resolve({ __kind: 'update' }),
        insert: () => Promise.resolve({ __kind: 'insert' }),
      }
      return fn(tx)
    })
    const fakeDb = { transaction }

    await runAtomically(fakeDb as never, (handle) => {
      const db = handle as unknown as { update: () => unknown; insert: () => unknown }
      const queries = [db.update(), db.insert()]
      built.push(...queries)
      return queries as never[]
    })

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(built).toHaveLength(2)
  })

  it('refuses to run a multi-statement write when the driver has no transaction()', async () => {
    await expect(runAtomically({} as never, () => [])).rejects.toThrow(/no transaction\(\)/)
  })

  it('reports driver capability without throwing', () => {
    expect(supportsAtomicBatch({ transaction: () => undefined })).toBe(true)
    expect(supportsAtomicBatch({ batch: () => undefined })).toBe(false)
    expect(supportsAtomicBatch({})).toBe(false)
    expect(supportsAtomicBatch(null)).toBe(false)
  })
})

describe.skipIf(!hasTestDatabase)('runAtomically (real Postgres)', () => {
  let handle: TestDbHandle

  const probe = pgTable('atomic_probe_guard', {
    id: integer('id').primaryKey(),
    appliedAt: timestamp('applied_at'),
  })
  const effect = pgTable('atomic_probe_effect', {
    id: serial('id').primaryKey(),
    refId: integer('ref_id').notNull(),
    required: text('required').notNull(),
  })

  beforeAll(async () => {
    handle = await createTestDb({ database: 'clipmux_t_atomicwrite_tx' })
    await handle.exec(GUARD_DDL)
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('commits both statements on the postgres-js transaction path', async () => {
    await runAtomically(handle.db as never, (tx) => {
      const d = tx as unknown as typeof handle.db
      return [
        d.update(probe).set({ appliedAt: new Date() }).where(eq(probe.id, 1)),
        d.insert(effect).values({ refId: 1, required: 'ok' }),
      ] as never[]
    })

    const guards = normalizeRows(
      await handle.db.execute(sql`SELECT applied_at FROM atomic_probe_guard WHERE id = 1`),
    )
    expect(guards[0]?.applied_at).not.toBeNull()
    expect(await countEffects()).toBeGreaterThan(0)
  })

  it('rolls the whole transaction back when the second statement fails', async () => {
    // Reset so the guard is unapplied, then attempt update + failing insert.
    await handle.exec(`UPDATE atomic_probe_guard SET applied_at = NULL WHERE id = 1`)
    const before = await countEffects()

    await expect(
      runAtomically(handle.db as never, (tx) => {
        const d = tx as unknown as typeof handle.db
        return [
          d.update(probe).set({ appliedAt: new Date() }).where(eq(probe.id, 1)),
          d.insert(effect).values({ refId: 1, required: null as unknown as string }),
        ] as never[]
      }),
    ).rejects.toThrow()

    // The UPDATE executed first and succeeded; only the transaction rolled it back.
    const guards = normalizeRows(
      await handle.db.execute(sql`SELECT applied_at FROM atomic_probe_guard WHERE id = 1`),
    )
    expect(guards).toEqual([{ applied_at: null }])
    expect(await countEffects()).toBe(before)
  })

  const countEffects = async (): Promise<number> => {
    const rows = normalizeRows(
      await handle.db.execute(sql`SELECT count(*)::int AS n FROM atomic_probe_effect`),
    )
    return Number(rows[0]?.n ?? -1)
  }
})
