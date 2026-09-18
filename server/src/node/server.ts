/**
 * Node runtime entrypoint (Docker / VPS deployments, and `pnpm dev`).
 *
 * Boots the Hono app under @hono/node-server, with the Node composition root
 * supplying everything platform-specific:
 *
 * - `process.env` as the environment (loaded from `.dev.vars` in development)
 * - background work tracked instead of `ctx.waitUntil`, including the request
 *   context Hono exposes as `c.executionCtx`
 * - playback telemetry forwarded to the delivery worker when configured
 * - in-process maintenance on this instance when a database is configured
 * - fatal configuration problems refuse to start
 */

import '../lib/load-local-env'
import { serve } from '@hono/node-server'
import { createApp } from '../app'
import { createNodeRequestHandler, createNodeRuntime } from '../runtime/node'
import { parseEnabledFlag, type EnvLike } from '../lib/config'
import { runMaintenance } from '../utils/maintenance'
import {
  createMaintenanceScheduler,
  maintenanceIntervalMs,
} from '../utils/maintenanceScheduler'

const env = process.env as unknown as EnvLike
const runtimeBase = createNodeRuntime(env)

for (const advisory of runtimeBase.advisories) {
  console.warn(`[clipmux-api] advisory: ${advisory}`)
}
if (runtimeBase.problems.length > 0) {
  console.warn('[clipmux-api] configuration problems:')
  for (const problem of runtimeBase.problems) {
    console.warn(`[clipmux-api]   - ${problem.message}`)
  }
}

const fatal = runtimeBase.problems.filter((problem) => problem.fatal)
if (fatal.length > 0) {
  console.error('[clipmux-api] refusing to start:')
  for (const problem of fatal) {
    console.error(`[clipmux-api]   - ${problem.message}`)
  }
  process.exit(1)
}

const databaseConfigured = Boolean(runtimeBase.env['DATABASE_URL']?.trim())
const sweepEnabled = parseEnabledFlag(runtimeBase.env, 'SWEEP_ENABLED', true)
const scheduler = createMaintenanceScheduler({
  enabled: sweepEnabled && databaseConfigured,
  intervalMs: maintenanceIntervalMs(runtimeBase.env),
  run: () => runMaintenance(runtimeBase.env),
  onError: (error) => {
    console.error('[clipmux-api] maintenance pass failed:', error)
  },
})

const runtime = {
  ...runtimeBase,
  ...(sweepEnabled && databaseConfigured
    ? { runMaintenancePass: () => scheduler.runNow() }
    : {}),
}

const app = createApp(runtime)
const handleRequest = createNodeRequestHandler(app, runtime)
const port = Number(process.env.PORT || 4080)

const server = serve(
  {
    fetch: handleRequest,
    port,
    // Never read `HOSTNAME`: every Unix shell and Docker sets it to the
    // machine/container name (e.g. `vishyy`), not a bind address, so binding
    // to it puts the API on an unreachable interface. Default to all
    // interfaces; `API_HOST` opts into a specific one.
    hostname: process.env.API_HOST || '0.0.0.0',
  },
  (info) => {
    console.log(
      `[clipmux-api] listening on http://${info.address}:${info.port} ` +
        `(runtime=${runtime.shape.runtime}, db=${runtime.shape.dbTransport}, ` +
        `rate-limit=${runtime.shape.rateLimitStore}, ` +
        `transcode=${runtime.shape.transcodeProvider}, ` +
        `analytics-write=${runtime.shape.analyticsWrite})`,
    )
    if (sweepEnabled && databaseConfigured) {
      scheduler.start()
      console.log(
        `[clipmux-api] maintenance scheduler started ` +
          `(interval=${maintenanceIntervalMs(runtime.env) / 1000}s)`,
      )
    } else if (!sweepEnabled) {
      console.log('[clipmux-api] maintenance scheduler disabled (SWEEP_ENABLED=false)')
    }
  },
)

const SHUTDOWN_MS = 10_000

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[clipmux-api] ${signal} received, shutting down`)
    scheduler.stop()
    server.close(() => {
      void scheduler.waitForIdle().then(() => process.exit(0))
    })
    setTimeout(() => process.exit(0), SHUTDOWN_MS).unref()
  })
}
