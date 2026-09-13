/**
 * Node runtime entrypoint (Docker / VPS deployments, and `pnpm dev`).
 *
 * Boots the same Hono app as the Cloudflare Worker, under @hono/node-server,
 * with the Node composition root supplying everything platform-specific:
 *
 * - `process.env` as the environment (loaded from `.dev.vars` in development)
 * - background work tracked instead of `ctx.waitUntil`, including the request
 *   context Hono exposes as `c.executionCtx` — Node has no platform one, and
 *   Hono's getter throws instead of returning undefined
 * - no Analytics Engine binding, so `analyticsWrite: 'none'` — reported by
 *   `GET /health/config` and answered by `/api/playback` as "not configured"
 *   rather than being discovered mid-request
 * - fatal configuration problems refuse to start, instead of a deployment that
 *   looks healthy and fails on the second request
 */

import '../lib/load-local-env'
import { serve } from '@hono/node-server'
import { createApp } from '../app'
import { createNodeRequestHandler, createNodeRuntime } from '../runtime/node'
import type { EnvLike } from '../lib/config'

const env = process.env as unknown as EnvLike
const runtime = createNodeRuntime(env)

for (const advisory of runtime.advisories) {
  console.warn(`[openvod-api] advisory: ${advisory}`)
}
if (runtime.problems.length > 0) {
  console.warn('[openvod-api] configuration problems:')
  for (const problem of runtime.problems) {
    console.warn(`[openvod-api]   - ${problem.message}`)
  }
}

// Fatal problems are the combinations that cannot work at all (a TCP Postgres or
// a TCP Redis on Workers, an unrecognised TRANSCODE_PROVIDER). Everything else is
// reported and the server still boots: a half-configured installation should be
// able to answer /health/config and say what is missing.
const fatal = runtime.problems.filter((problem) => problem.fatal)
if (fatal.length > 0) {
  console.error('[openvod-api] refusing to start:')
  for (const problem of fatal) {
    console.error(`[openvod-api]   - ${problem.message}`)
  }
  process.exit(1)
}

const app = createApp(runtime)
const handleRequest = createNodeRequestHandler(app, runtime)
const port = Number(process.env.PORT || 4080)

const server = serve(
  {
    // Bindings are gone as a concept here: the runtime already resolved
    // everything from `process.env`, and the app reads it from `c.var.runtime`.
    // The handler is also where this runtime gets the request context Hono
    // exposes as `c.executionCtx` — Node has no platform one to hand over.
    fetch: handleRequest,
    port,
    hostname: process.env.HOSTNAME || '0.0.0.0',
  },
  (info) => {
    console.log(
      `[openvod-api] listening on http://${info.address}:${info.port} ` +
        `(runtime=${runtime.shape.runtime}, db=${runtime.shape.dbTransport}, ` +
        `rate-limit=${runtime.shape.rateLimitStore}, ` +
        `transcode=${runtime.shape.transcodeProvider}, ` +
        `analytics-write=${runtime.shape.analyticsWrite})`,
    )
  },
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[openvod-api] ${signal} received, shutting down`)
    server.close(() => process.exit(0))
    // Hard stop if close hangs (in-flight streams).
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
