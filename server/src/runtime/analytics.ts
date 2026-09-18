/**
 * Playback telemetry sinks.
 *
 * Node forwards normalized rows to the delivery worker, which writes them into
 * the Analytics Engine `playback_events` dataset. The dataset layout
 * (blob/double/index order) lives in the delivery worker — this module's job is
 * to POST the rows the journal route already shaped.
 *
 * Acceptance does not promise durable storage: a five-second timeout, no
 * retries, and a sanitized log on failure.
 */

import { WAE_MAX_DATA_POINTS_PER_INVOCATION } from '../lib/analytics-engine'
import type { AnalyticsPort, PlaybackRow } from './types'

export const ANALYTICS_FORWARD_TIMEOUT_MS = 5_000
export const ANALYTICS_INGEST_PATH = '/internal/analytics/playback'
/** Matches delivery `INGEST_MAX_BODY_BYTES`. */
export const ANALYTICS_FORWARD_MAX_BODY_BYTES = 1024 * 1024

export const nullAnalytics: AnalyticsPort = {
  canWritePlayback: false,
  writePlayback: async () => 0,
}

export type AnalyticsForwarderOptions = {
  deliveryUrl: string
  ingestSecret: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Split rows so each POST stays within the delivery ingest body cap and the
 * Analytics Engine per-invocation write limit. A public journal batch can be
 * under 1 MiB and still exceed that cap after Node adds viewer metadata.
 */
export function splitPlaybackForwardBatches(
  rows: readonly PlaybackRow[],
  maxBodyBytes = ANALYTICS_FORWARD_MAX_BODY_BYTES,
  maxEvents = WAE_MAX_DATA_POINTS_PER_INVOCATION,
): PlaybackRow[][] {
  if (rows.length === 0) return []
  const prefixBytes = utf8Bytes('{"events":[]}')
  const encodedBytes = rows.map((row) => utf8Bytes(JSON.stringify(row)))
  const batches: PlaybackRow[][] = []
  let current: PlaybackRow[] = []
  let currentBytes = prefixBytes

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const rowBytes = encodedBytes[i]!
    const extra = current.length === 0 ? rowBytes : rowBytes + 1
    if (current.length > 0 && (current.length >= maxEvents || currentBytes + extra > maxBodyBytes)) {
      batches.push(current)
      current = []
      currentBytes = prefixBytes
    }
    current.push(row)
    currentBytes += current.length === 1 ? rowBytes : rowBytes + 1
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Forward playback rows to the delivery worker's ingest endpoint.
 *
 * The delivery worker must not substitute the Node host's location or user
 * agent: every viewer field in `rows` is already resolved by the API.
 */
export function deliveryAnalyticsForwarder(options: AnalyticsForwarderOptions): AnalyticsPort {
  const timeoutMs = options.timeoutMs ?? ANALYTICS_FORWARD_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = `${options.deliveryUrl.replace(/\/+$/, '')}${ANALYTICS_INGEST_PATH}`

  const postBatch = async (batch: PlaybackRow[]): Promise<number> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.ingestSecret}`,
        },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
      })
      if (!response.ok) {
        console.error(
          `[analytics] delivery ingest failed: status=${response.status} count=${batch.length}`,
        )
        return 0
      }
      const body = (await response.json().catch(() => null)) as { accepted?: unknown } | null
      const accepted = typeof body?.accepted === 'number' ? body.accepted : batch.length
      return Number.isFinite(accepted) && accepted > 0 ? Math.min(accepted, batch.length) : 0
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'error'
      console.error(`[analytics] delivery ingest failed: reason=${reason} count=${batch.length}`)
      return 0
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    canWritePlayback: true,
    async writePlayback(rows: PlaybackRow[]): Promise<number> {
      if (rows.length === 0) return 0
      let accepted = 0
      for (const batch of splitPlaybackForwardBatches(rows)) {
        accepted += await postBatch(batch)
      }
      return accepted
    },
  }
}
