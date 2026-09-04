import app from './app'
import { runSweep } from './utils/jobSweeper'
import { createSweepAdapters, sweepLimitsFromEnv } from './utils/sweepAdapters'
import type { Bindings } from './types'

/**
 * Worker entry. Serves the Hono app and optionally runs the job sweeper on
 * scheduled triggers (opt-in via SWEEP_ENABLED=true; add a cron trigger in
 * wrangler.jsonc, or call POST /api/internal/sweep with INTERNAL_SWEEP_SECRET
 * from your own scheduler).
 */
export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (env.SWEEP_ENABLED !== 'true') {
      return
    }
    const started = Date.now()
    ctx.waitUntil(
      runSweep(new Date(), sweepLimitsFromEnv(env), createSweepAdapters(env)).then(
        (stats) => {
          console.log(`[SWEEP] scheduled pass finished in ${Date.now() - started}ms`, stats)
        },
        (err) => {
          console.error('[SWEEP] scheduled pass failed:', err)
        },
      ),
    )
  },
}
