import { Hono } from 'hono'
import { loadConfig, parseUploadsEnabled, type EnvLike } from '../lib/config'
import { db } from '../lib/database'
import { transcoderAgent } from '../db/schema'
import {
  buildPublicCapabilities,
  type AgentRow,
} from '../lib/agentCapabilities'
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
    // Split capability reporting, and deliberately coarse.
    //
    // An unauthenticated caller learning that an organization runs three agents
    // with specific hostnames is an information disclosure with no upside, so
    // this projection is booleans and counts: `uploads` answers "can a browser
    // upload be processed?", `localImport` answers "can a file on the owner's
    // machine be imported?", and `providers` says what is wired up. Agent names,
    // hostnames, paths and credentials are in the authenticated dashboard health
    // (`/api/transcoder/health`).
    transcode: await buildTranscodeCapabilities(cfg, parseUploadsEnabled(env)),
  })
})

async function buildTranscodeCapabilities(
  cfg: ReturnType<typeof loadConfig>,
  uploadsEnabled: boolean,
) {
  // Agent rows are counted by state, not listed: the query selects only what the
  // public projection needs, so a field added for the dashboard cannot leak here
  // by accident.
  let agents: AgentRow[] = []
  try {
    agents = await db
      .select({
        id: transcoderAgent.id,
        name: transcoderAgent.name,
        enabled: transcoderAgent.enabled,
        lastSeenAt: transcoderAgent.lastSeenAt,
        capabilities: transcoderAgent.capabilities,
      })
      .from(transcoderAgent)
  } catch (error) {
    // A missing table (an installation that has not migrated yet) must not take
    // down the health endpoint the setup wizard reads.
    console.error('[HEALTH] agent lookup failed:', error)
  }

  return buildPublicCapabilities({
    modalWebhookUrl: cfg.modalWebhookUrl,
    ingestSecret: cfg.ingestSecret,
    rawBucket: uploadsEnabled ? cfg.rawBucket : null,
    transcodedBucket: cfg.transcodedBucket,
    hasStorageCredentials: cfg.checks.storage,
    agents,
    defaultProvider: cfg.transcodeProvider,
    selfHostedEnabled: cfg.selfHostedEnabled,
    aiEnabled: cfg.checks.ai,
  })
}

export default healthApp
