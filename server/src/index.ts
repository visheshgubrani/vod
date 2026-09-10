import app from './app'
import { runMaintenance, isMaintenanceEnabled } from './utils/maintenance'
import type { Bindings } from './types'

/**
 * Worker entry. Serves the Hono app and optionally runs maintenance on
 * scheduled triggers.
 *
 * Maintenance is opt-in via SWEEP_ENABLED=true plus a cron trigger in
 * wrangler.jsonc (see the commented example there), or by calling
 * `POST /api/internal/sweep` with INTERNAL_SWEEP_SECRET from your own
 * scheduler — Docker deployments use the `maintenance` compose service.
 *
 * Both paths run the *same* maintenance pass. That matters: this handler
 * previously ran only the transcode sweep, so a deployment that had configured
 * the documented Workers cron still never retried a single webhook.
 */
export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (!isMaintenanceEnabled(env)) {
      console.log(
        '[MAINTENANCE] scheduled pass skipped: SWEEP_ENABLED is not "true". ' +
          'Webhook retries do not run either.',
      )
      return
    }

    ctx.waitUntil(
      runMaintenance(env).then(
        (result) => {
          console.log(
            `[MAINTENANCE] scheduled pass finished in ${result.durationMs}ms`,
            result,
          )
        },
        (err) => {
          console.error('[MAINTENANCE] scheduled pass failed:', err)
        },
      ),
    )
  },
}
