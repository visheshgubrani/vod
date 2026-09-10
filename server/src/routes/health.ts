import { Hono } from 'hono'
import { loadConfig, type EnvLike } from '../lib/config'
import { readMaintenanceStatus } from '../utils/maintenance'
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
healthApp.get('/config', async (c) => {
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

  // Background processing is opt-in, and leaving it off is not a cosmetic
  // choice: webhook retries and byte reclamation both stop, so deleted videos
  // keep costing storage and failed deliveries are never retried. Surfacing it
  // here makes that visible instead of silent. Booleans only — no secrets.
  // Configured intent AND observed evidence. A deployment can have the flag on
  // and still never run a pass, which is exactly the silent failure this
  // reports: `stale` is true when it is enabled but no recent pass succeeded.
  const maintenance = await readMaintenanceStatus(env)
  if (!maintenance.enabled) {
    cfg.advisories.push(
      'SWEEP_ENABLED is not "true": background maintenance is off, so webhook ' +
        'retries and storage reclamation will not run (see docs/deploy.md).',
    )
  } else if (maintenance.stale) {
    cfg.advisories.push(
      maintenance.lastSucceededAt
        ? `Background maintenance is enabled but last succeeded at ${maintenance.lastSucceededAt} — check the cron trigger or the compose maintenance service.`
        : 'Background maintenance is enabled but has never run — check the cron trigger or the compose maintenance service.',
    )
  }

  return c.json({
    service: 'openvod',
    time: new Date().toISOString(),
    ready: cfg.ready,
    checks: cfg.checks,
    maintenance,
    problems: cfg.problems,
    advisories: cfg.advisories,
  })
})

export default healthApp
