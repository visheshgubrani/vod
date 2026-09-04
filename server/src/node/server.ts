/**
 * Node runtime entry for the OpenVOD API (Docker/VPS deployments).
 *
 * Boots the same Hono app as the Cloudflare Worker, but under @hono/node-server
 * with:
 * - env vars as the binding source (process.env is native on Node)
 * - a waitUntil polyfill so fire-and-forget paths (webhook dispatch, rate
 *   limit analytics sync) keep working without an ExecutionContext
 * - Analytics Engine bindings absent -> those routes answer 501 "not
 *   configured" by design; bandwidth/playback stats need the delivery Worker
 *   + CF account token instead
 */
import 'dotenv/config'
import { serve } from '@hono/node-server'
import app from '../app'
import type { Bindings } from '../types'

const fakeExecutionContext = {
  waitUntil(promise: Promise<unknown>): void {
    Promise.resolve(promise).catch((err) => {
      console.error('[waitUntil] background task failed:', err)
    })
  },
} as unknown as ExecutionContext

const envBindings = process.env as unknown as Bindings

const port = Number(process.env.PORT || 4080)

const server = serve(
  {
    fetch: (request) => app.fetch(request, envBindings, fakeExecutionContext),
    port,
    hostname: process.env.HOSTNAME || '0.0.0.0',
  },
  (info) => {
    console.log(`[openvod-api] listening on http://${info.address}:${info.port}`)
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
