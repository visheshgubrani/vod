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

import type { Bindings } from '../types'

export const PLAYBACK_DATASET = 'playback_events'

/** Cloudflare WAE limit: max writeDataPoint calls per Worker invocation */
export const WAE_MAX_DATA_POINTS_PER_INVOCATION = 250

/**
 * Viewer identity for uniq counts: prefer authenticated userId (blob8),
 * otherwise fall back to sessionId (blob3). Matches pre-migration ClickHouse:
 * uniq(ifNull(user_id, toString(session_id))).
 */
export const VIEWER_IDENTITY_SQL = `if(blob8 = '', blob3, blob8)`

export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

export function getAnalyticsConfig(env?: Partial<Bindings>) {
  const accountId = env?.ACCOUNT_ID || (typeof process !== 'undefined' ? process.env?.ACCOUNT_ID : undefined)
  const apiToken =
    env?.CLOUDFLARE_ANALYTICS_TOKEN ||
    (typeof process !== 'undefined' ? process.env?.CLOUDFLARE_ANALYTICS_TOKEN : undefined)
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
    throw new Error(`Analytics Engine query failed: ${response.status}`)
  }

  const result = (await response.json()) as { data: T[] }
  return result.data ?? []
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
