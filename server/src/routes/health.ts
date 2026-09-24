import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { ClipMuxConfig } from '../lib/config'
import { db } from '../lib/database'
import { localWorker, organization } from '../db/schema'
import { buildPublicCapabilities, isLocalWorkerLive } from '../lib/localWorkerCapabilities'
import { readMaintenanceStatus } from '../utils/maintenance'
import type { Bindings } from '../types'

export const healthApp = new Hono<{ Bindings: Bindings }>()

/** GET /health — plain-text liveness probe. */
healthApp.get('/', (c) => c.text('ok'))

/** GET /health/config — secret-free deployment and coarse local-worker status. */
healthApp.get('/config', async (c) => {
  const cfg = c.var.runtime.config
  const env = c.var.runtime.env
  const maintenance = await readMaintenanceStatus(env)
  const advisories = [...cfg.advisories]
  if (!maintenance.enabled) {
    advisories.push(
      'SWEEP_ENABLED is false: background maintenance is off, so webhook retries and storage reclamation will not run on this instance (see docs/deploy.md).',
    )
  } else if (maintenance.stale) {
    advisories.push(
      maintenance.lastSucceededAt
        ? `Background maintenance is enabled but last succeeded at ${maintenance.lastSucceededAt} — check this API instance’s logs.`
        : 'Background maintenance is enabled but has never run — check this API instance’s logs.',
    )
  }

  return c.json({
    service: 'clipmux',
    time: new Date().toISOString(),
    ready: cfg.ready,
    checks: cfg.checks,
    deployment: c.var.runtime.shape,
    maintenance,
    problems: c.var.runtime.problems.map((problem) => problem.message),
    advisories,
    transcode: await buildTranscodeCapabilities(cfg, cfg.uploadsEnabled),
  })
})

async function buildTranscodeCapabilities(cfg: ClipMuxConfig, uploadsEnabled: boolean) {
  let worker: typeof localWorker.$inferSelect | null = null
  let importOrgExists = false
  try {
    const [row] = await db
      .select()
      .from(localWorker)
      .where(eq(localWorker.id, 'local'))
      .limit(1)
    worker = row ?? null
    if (cfg.localImportOrgId) {
      const [org] = await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, cfg.localImportOrgId))
        .limit(1)
      importOrgExists = Boolean(org)
    }
  } catch (error) {
    console.error('[HEALTH] local worker lookup failed:', error)
  }

  const online = isLocalWorkerLive(worker?.lastSeenAt ?? null)
  return buildPublicCapabilities({
    modalConfigured: Boolean(cfg.modalWebhookUrl && cfg.ingestSecret),
    localConfigured: Boolean(cfg.localTranscoderSecret),
    localEnabled: cfg.localTranscodeEnabled,
    localWorkerOnline: online,
    localImportConfigured: Boolean(cfg.localImportOrgId && importOrgExists),
    rawBucket: uploadsEnabled ? cfg.rawBucket : null,
    transcodedBucket: cfg.transcodedBucket,
    hasStorageCredentials: cfg.storageCredentials,
    defaultProvider: cfg.transcodeProvider,
    aiEnabled: cfg.checks.ai,
    workerCapabilities: worker?.capabilities,
  })
}

export default healthApp
