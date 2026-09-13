import { Hono } from 'hono'
import type { OpenVodConfig } from '../lib/config'
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
  // Configuration and the resolved deployment shape come from the composition
  // root. This route used to rebuild the "process.env + string c.env" merge
  // itself — a second copy of the bindings bridge, and the only production
  // caller of loadConfig.
  const cfg = c.var.runtime.config
  const env = c.var.runtime.env

  // Background processing is opt-in, and leaving it off is not a cosmetic
  // choice: webhook retries and byte reclamation both stop, so deleted videos
  // keep costing storage and failed deliveries are never retried. Surfacing it
  // here makes that visible instead of silent. Booleans only — no secrets.
  // Configured intent AND observed evidence. A deployment can have the flag on
  // and still never run a pass, which is exactly the silent failure this
  // reports: `stale` is true when it is enabled but no recent pass succeeded.
  const maintenance = await readMaintenanceStatus(env)
  // A local copy: `cfg` is the runtime's shared configuration object, and pushing
  // into it would accumulate this advisory on every request for the lifetime of
  // the process (or isolate).
  const advisories = [...cfg.advisories]
  if (!maintenance.enabled) {
    advisories.push(
      'SWEEP_ENABLED is not "true": background maintenance is off, so webhook ' +
        'retries and storage reclamation will not run (see docs/deploy.md).',
    )
  } else if (maintenance.stale) {
    advisories.push(
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
    // What this deployment actually resolved to — runtime, transports, providers,
    // stores. Flat and secret-free, so an operator can see which choices are in
    // force instead of inferring them from defaults. See docs/deployment-shapes.md.
    deployment: c.var.runtime.shape,
    maintenance,
    // Every problem, fatal or not, as strings — the shape the dashboard already
    // reads.
    problems: c.var.runtime.problems.map((problem) => problem.message),
    advisories,
    // Split capability reporting, and deliberately coarse.
    //
    // An unauthenticated caller learning that an organization runs three agents
    // with specific hostnames is an information disclosure with no upside, so
    // this projection is booleans and counts: `uploads` answers "can a browser
    // upload be processed?", `localImport` answers "can a file on the owner's
    // machine be imported?", and `providers` says what is wired up. Agent names,
    // hostnames, paths and credentials are in the authenticated dashboard health
    // (`/api/transcoder/health`).
    transcode: await buildTranscodeCapabilities(cfg, cfg.uploadsEnabled),
  })
})

async function buildTranscodeCapabilities(
  cfg: OpenVodConfig,
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
