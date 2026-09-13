/**
 * Cloudflare Workers entrypoint.
 *
 * Bindings and the ExecutionContext are real platform arguments here — nothing
 * is fabricated. The isolate runtime and the Hono app are built once per isolate
 * (bindings are stable for its lifetime) and the per-request background runner is
 * bound by the app's first middleware via `runtime.forRequest`.
 */

import { createApp } from './app'
import { isMaintenanceEnabled, runMaintenance } from './utils/maintenance'
import { getWorkersRuntime, type WorkersIsolateRuntime } from './runtime/workers'
import type { Hono } from 'hono'
import type { Bindings } from './types'

/**
 * Maintenance is opt-in via SWEEP_ENABLED=true plus the cron trigger in
 * wrangler.jsonc, or by calling `POST /api/internal/sweep` with
 * INTERNAL_SWEEP_SECRET from your own scheduler — a Node deployment uses the
 * `maintenance` compose service instead.
 *
 * Both paths run the *same* maintenance pass. That matters: this handler
 * previously ran only the transcode sweep, so a deployment that had configured
 * the documented Workers cron still never retried a single webhook.
 */
export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const runtime = getWorkersRuntime(env)
    cached = cached && cached.runtime === runtime ? cached : { runtime, app: createApp(runtime) }
    return cached.app.fetch(request, env, ctx)
  },

  async scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    const runtime = getWorkersRuntime(env)
    if (!isMaintenanceEnabled(runtime.env)) {
      console.log(
        '[MAINTENANCE] scheduled pass skipped: SWEEP_ENABLED is not "true". ' +
          'Webhook retries do not run either.',
      )
      return
    }

    ctx.waitUntil(
      runMaintenance(runtime.env).then(
        (result) => {
          console.log(`[MAINTENANCE] scheduled pass finished in ${result.durationMs}ms`, result)
        },
        (err) => {
          console.error('[MAINTENANCE] scheduled pass failed:', err)
        },
      ),
    )
  },
}

/** Memoised alongside the isolate runtime so the two can never disagree. */
let cached: { runtime: WorkersIsolateRuntime; app: Hono<{ Bindings: Bindings }> } | null = null
