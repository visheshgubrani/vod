/**
 * Render a drizzle `SQL` object to its Postgres text and bound parameters.
 *
 * Why this exists: a large share of the guarantees in this codebase live in the
 * *shape* of a statement — which guards are present, whether the cap is a
 * correlated subquery, whether publication is gated on verification. Those are
 * properties of the SQL, and asserting them against the real database would mean
 * standing up Postgres for what is really a structural claim.
 *
 * `sqlToQuery` is drizzle's own dialect renderer, so what is asserted here is
 * what the driver will actually send (modulo `$n` placeholders).
 */
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

export type RenderedSql = {
  sql: string
  params: unknown[]
}

export function renderSql(query: SQL): RenderedSql {
  const dialect = new PgDialect()
  const rendered = dialect.sqlToQuery(query)
  return { sql: rendered.sql, params: [...(rendered.params ?? [])] }
}

export function sqlText(query: SQL): string {
  return renderSql(query).sql
}

/** Whitespace-insensitive containment, so reformatting never breaks a test. */
export function containsClause(query: SQL, fragment: string): boolean {
  return normalize(sqlText(query)).includes(normalize(fragment))
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
