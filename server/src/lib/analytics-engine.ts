/**
 * Cloudflare Workers Analytics Engine helpers for playback telemetry.
 *
 * Dataset: playback_events (wrangler binding PLAYBACK_ANALYTICS)
 *
 * Field layout:
 * - blob1: event (play, pause, heartbeat, error, seeking, ...)
 * - blob2: videoId
 * - blob3: sessionId
 * - blob4: country
 * - blob5: device
 * - blob6: browser
 * - blob7: errorCode
 * - blob8: userId (empty string when anonymous)
 * - double1: watchedDelta (seconds)
 * - double2: currentTime (seconds)
 * - double3: duration (seconds)
 * - index1: organizationId
 */

import type { ClipMuxConfig } from './config'

export const PLAYBACK_DATASET = 'playback_events'

/** Cloudflare WAE limit: max writeDataPoint calls per Worker invocation */
export const WAE_MAX_DATA_POINTS_PER_INVOCATION = 250

/**
 * Viewer identity for uniq counts: prefer authenticated userId (blob8),
 * otherwise fall back to sessionId (blob3). Both branches are Strings, which is
 * what the pre-migration ClickHouse `uniq(ifNull(...))` became once NULL left
 * the picture (see the dialect note below).
 */
export const VIEWER_IDENTITY_SQL = `if(blob8 = '', blob3, blob8)`

/**
 * Cloudflare Analytics Engine SQL is a *restricted* ClickHouse dialect, and the
 * restrictions are not the ones ClickHouse habits predict:
 *
 * - `IF()` requires its 2nd and 3rd arguments to have the same type. Both
 *   `if(cond, blob3, NULL)` (String vs Null) and `if(cond, 0, 1.5)` (Integer vs
 *   Double) are rejected with a 422 before the query runs. There is no implicit
 *   promotion, and a float literal such as `0.0` is how a Double is written.
 * - `NULL` cannot be combined with `OR` either
 *   (`cannot combine the Boolean and Null types with the OR operator`).
 * - `toFloat64`, `nullIf`, `coalesce`, `ifNull`, `uniq` and `uniqCombined` do
 *   not exist (`unknown function call`). `count(DISTINCT ...)` does.
 *
 * So a "no value" branch has to be a *typed* placeholder, which is what this
 * sentinel is for. `count(DISTINCT ...)` counts the sentinel as one value, so it
 * must not be a sessionId a player could send; `__cm_none__` is not a UUID and
 * the player only ever sends the opaque id it generated itself.
 */
export const NO_SESSION_SENTINEL = '__cm_none__'

/**
 * `blob3`, or a non-colliding sentinel when `condition` is false — never NULL,
 * because Analytics Engine rejects `if(cond, blob3, NULL)` outright.
 *
 * Used inside `count(DISTINCT ...)` to count sessions matching a predicate:
 * distinct sessionIds are unaffected by the sentinel, which contributes at most
 * one bogus value when no session matches.
 */
export function sessionIdOrNone(condition: string): string {
  return `if(${condition}, blob3, '${NO_SESSION_SENTINEL}')`
}

export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Credentials for the Analytics Engine SQL API, or null when unconfigured.
 *
 * Takes the resolved configuration: the read path is an ordinary HTTPS call, so
 * the only question is whether the token exists.
 */
export function getAnalyticsConfig(
  config: Pick<ClipMuxConfig, 'accountId' | 'cloudflareAnalyticsToken'> & {
    analyticsEnabled?: boolean
  },
): { accountId: string; apiToken: string } | null {
  if (config.analyticsEnabled === false) return null
  const accountId = config.accountId
  const apiToken = config.cloudflareAnalyticsToken
  if (!accountId || !apiToken) return null
  return { accountId, apiToken }
}

export async function queryAnalyticsEngine<T = Record<string, unknown>>(
  sql: string,
  accountId: string,
  apiToken: string,
): Promise<T[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: sql,
    },
  )

  if (!response.ok) {
    const errorText = await response.text()
    console.error('Analytics Engine SQL error:', response.status, errorText)
    throw new AnalyticsEngineQueryError(response.status, errorText)
  }

  const result = (await response.json()) as { data: T[] }
  return result.data ?? []
}

/**
 * An Analytics Engine SQL failure that keeps the reason.
 *
 * The response body ("Input was invalid: the 2nd and 3rd arguments to IF() ...")
 * is the only thing that says *why* a query was rejected, and it used to reach
 * the server console alone — a dashboard consumer saw a bare 500 and had to go
 * find the operator. The reason is a parse error about our own SQL: no
 * credential, tenant data or user input is in it.
 */
export class AnalyticsEngineQueryError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Analytics Engine query failed: ${status}`)
    this.name = 'AnalyticsEngineQueryError'
  }
}

/**
 * The upstream reason for a caught Analytics Engine failure, for a route's
 * response body — or undefined for anything else that reached the catch.
 */
export function analyticsErrorDetail(error: unknown): { detail: string } | undefined {
  return error instanceof AnalyticsEngineQueryError && error.detail
    ? { detail: error.detail.slice(0, 300) }
    : undefined
}

export function parseDays(param: string | undefined, fallback = 30): number {
  return Math.min(90, Math.max(1, Number.parseInt(param || String(fallback), 10) || fallback))
}

export function parseIntWithBounds(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (!value) return defaultValue

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return defaultValue
  }

  return Math.min(Math.max(parsed, min), max)
}

export function parseOptionalIntWithBounds(
  value: string | undefined,
  min: number,
  max: number,
): number | null {
  if (!value) return null

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return null
  }

  return Math.min(Math.max(parsed, min), max)
}
