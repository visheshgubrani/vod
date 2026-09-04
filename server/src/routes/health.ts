import { Hono } from 'hono'
import { loadConfig, type EnvLike } from '../lib/config'
import type { Bindings } from '../types'

export const healthApp = new Hono<{ Bindings: Bindings }>()

/**
 * GET /health — plain-text liveness probe.
 */
healthApp.get('/', (c) => c.text('ok'))

/**
 * GET /health/config — public, no secrets.
 *
 * Reports which BYOK capabilities are configured for this deployment.
 * Consumed by the dashboard "Developer Welcome" health cards and the
 * setup wizard. Never include secret values or connection strings.
 */
healthApp.get('/config', (c) => {
  const env: EnvLike = {
    ...(typeof process !== 'undefined' ? (process.env as EnvLike) : {}),
  }
  // c.env may carry non-string bindings (Analytics Engine); copy only strings.
  if (c.env) {
    for (const key of Object.keys(c.env)) {
      const value = (c.env as Record<string, unknown>)[key]
      if (typeof value === 'string') env[key] = value
    }
  }
  const cfg = loadConfig(env)

  return c.json({
    service: 'openvod',
    time: new Date().toISOString(),
    ready: cfg.ready,
    checks: cfg.checks,
    problems: cfg.problems,
    advisories: cfg.advisories,
  })
})

export default healthApp
