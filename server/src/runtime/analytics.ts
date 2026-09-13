/**
 * Playback telemetry sinks.
 *
 * Writing needs a Cloudflare Analytics Engine *binding*, so it exists on Workers
 * and not on Node — a real capability difference, expressed as data
 * (`canWritePlayback`) instead of as a 501 discovered mid-request. Reads are an
 * ordinary HTTPS call to the Analytics Engine SQL API and work on both.
 *
 * The dataset layout (blob/double/index order) lives here rather than in the
 * route, because the route's job is to accept and shape an event, not to know
 * how a vendor stores it.
 */

import { WAE_MAX_DATA_POINTS_PER_INVOCATION } from '../lib/analytics-engine'
import type { AnalyticsPort, PlaybackRow } from './types'

export const nullAnalytics: AnalyticsPort = {
  canWritePlayback: false,
  writePlayback: () => 0,
}

/**
 * Analytics Engine sink.
 *
 * Blob order: event, videoId, sessionId, country, device, browser, errorCode,
 * userId. Doubles: watchedDelta, currentTime, duration. Index: organizationId.
 * (See lib/analytics-engine.ts, which documents the same layout for the SQL
 * side that reads it back.)
 */
export function workersAnalyticsEngine(
  dataset: AnalyticsEngineDataset | undefined,
): AnalyticsPort {
  if (!dataset) {
    return nullAnalytics
  }

  return {
    canWritePlayback: true,
    writePlayback(organizationId: string, rows: PlaybackRow[]): number {
      let written = 0
      for (const row of rows) {
        if (written >= WAE_MAX_DATA_POINTS_PER_INVOCATION) {
          break
        }
        dataset.writeDataPoint({
          blobs: [
            row.event,
            row.videoId,
            row.sessionId,
            row.country,
            row.device,
            row.browser,
            row.errorCode,
            row.userId,
          ],
          doubles: [row.watchedDelta, row.currentTime, row.duration],
          indexes: [organizationId || 'unknown'],
        })
        written += 1
      }
      return written
    },
  }
}
