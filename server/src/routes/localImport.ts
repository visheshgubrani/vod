/**
 * Local import: dashboard operations, agent-side source registration, and the
 * automation endpoint.
 *
 * Three audiences, three trust levels, one module — because they all end in the
 * same place (a video plus a queued job) and splitting them is how the dashboard
 * path and the CLI path drift apart on validation or on idempotency.
 *
 *   - `/api/transcoder/*` session auth. Organization queue controls and the
 *     configured import organization's browse/register/import operations.
 *   - `/api/transcoder/v1/sources` deployment-worker auth. The local worker
 *     registers root-relative files in LOCAL_IMPORT_ORG_ID.
 *   - `/v1/video/import-local`  API-key auth. Automation, accepting a
 *     **source reference** rather than a path or URL, so a compromised API key
 *     cannot ask the transcoder to read an arbitrary file.
 *
 * Browsing deserves a note. The browser never talks to the agent — the agent has
 * no listener by design. A browse is a row in `local_control_request`, answered
 * on the agent's next poll; the dashboard polls for the answer. That also means
 * a browse can time out, which is reported as a timeout rather than as an empty
 * folder: "the local worker did not answer" and "that folder is empty" are very
 * different messages.
 */

import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { requireApiKey } from '../middleware/apiKey'
import { requireLocalWorker } from '../middleware/localWorkerAuth'
import { db } from '../lib/database'
import {
  localControlRequest,
  member,
  transcodeJob,
  transcodeSource,
  localWorker,
  organization,
  video,
} from '../db/schema'
import { notDeleted } from '../db/predicates'
import { isLocalWorkerLive } from '../lib/localWorkerCapabilities'
import {
  buildCreateLocalImportStatement,
  DEFAULT_MAX_ATTEMPTS,
  readOutstandingWork,
  WAITING_REASONS,
} from '../lib/localJobQueue'
import { normalizeRows } from '../lib/atomicWrite'
import {
  runAtomically,
  supportsAtomicBatch,
  type AtomicBatchExecutor,
  type AtomicExecutor,
} from '../lib/atomicWrite'
import { dispatchWebhook } from '../utils/webhookDispatcher'
import type { Bindings } from '../types'
import type { EnvLike } from '../lib/config'
import type { LocalWorkerVariables } from '../middleware/localWorkerAuth'
import type { ApiKeyVariables } from '../types'

const CONTROL_TIMEOUT_MS = 30_000
const MAX_IMPORT_BATCH = 20

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard: /api/transcoder
// ═══════════════════════════════════════════════════════════════════════════════

export const dashboardApp = new Hono<{ Bindings: Bindings }>()
dashboardApp.use('/*', requireAuth)

async function activeOrganizationId(c: {
  var: { session: { activeOrganizationId?: string | null; userId: string } }
}): Promise<string | null> {
  const session = c.var.session
  if (session.activeOrganizationId) {
    const membership = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.userId, session.userId),
          eq(member.organizationId, session.activeOrganizationId),
        ),
      )
      .limit(1)
    if (membership.length > 0) return session.activeOrganizationId
  }
  return null
}

/** GET /worker — one read-only status record for this deployment. */
dashboardApp.get('/worker', async (c) => {
  const [row] = await db
    .select()
    .from(localWorker)
    .where(eq(localWorker.id, 'local'))
    .limit(1)
  const online = Boolean(row?.lastSeenAt && Date.now() - row.lastSeenAt.getTime() <= 90_000)
  const capabilities = row?.capabilities ?? {}
  const outstanding = await readOutstandingWork(db, { workerId: 'local' })
  const access = c.var.runtime.config.transcodeProvider === 'local' && c.var.runtime.config.localTranscodeEnabled && online
    ? await resolveImportAccess(c.var.runtime.env, c.var.session.userId)
    : null
  return c.json({
    provider: c.var.runtime.config.transcodeProvider,
    modalConfigured: c.var.runtime.config.transcodeProvider === 'modal' && c.var.runtime.config.checks.transcoder,
    importAvailable: Boolean(access?.ok),
    importOrganizationId: access?.ok ? access.organizationId : null,
    worker: row ? {
      online,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      hostname: row.hostname,
      version: row.workerVersion,
      capacityJobs: row.capacityJobs,
      capacityRenditions: row.capacityRenditions,
      activeJobs: outstanding.activeJobs,
      encoders: Array.isArray(capabilities.encoders) ? capabilities.encoders : [],
    } : null,
  })
})

/**
 * POST /browse — ask the agent for a directory listing.
 *
 * The result is fetched by a second call so a slow machine cannot hold the HTTP
 * request open past a Worker's limits. The control row carries the pagination
 * cursor and the root name; the response carries only root-relative paths.
 */
dashboardApp.post('/browse', async (c) => {
  const access = await resolveImportAccess(c.var.runtime.env, c.var.session.userId)
  if (!access.ok) return c.json({ error: access.error }, access.status)
  const organizationId = access.organizationId
  if (!await localImportReady(c.var.runtime.env)) return c.json({ error: 'The local worker must be online and selected as the provider to import host folders' }, 503)

  const body = await readJson(c)
  const expiresAt = new Date(Date.now() + CONTROL_TIMEOUT_MS)

  const inserted = await db
    .insert(localControlRequest)
    .values({
      organizationId,
      kind: 'browse',
      request: {
        rootName: typeof body?.rootName === 'string' ? body.rootName : null,
        // A root-relative path, or "." for the root itself. An absolute path is
        // never accepted here, so the dashboard cannot be used to enumerate a
        // host filesystem.
        path: typeof body?.path === 'string' && body.path ? body.path : '.',
        cursor: typeof body?.cursor === 'string' ? body.cursor : '',
        limit: Math.min(500, Math.max(1, Number(body?.limit) || 200)),
      },
      expiresAt,
    })
    .returning({ id: localControlRequest.id })

  return c.json({
    controlId: inserted[0].id,
    expiresAt: expiresAt.toISOString(),
    pollAfterMs: 500,
  })
})

/** GET /controls/:id — the answer to a browse or registration request. */
dashboardApp.get('/controls/:id', async (c) => {
  const access = await resolveImportAccess(c.var.runtime.env, c.var.session.userId)
  if (!access.ok) return c.json({ error: access.error }, access.status)
  const organizationId = access.organizationId

  const rows = await db
    .select()
    .from(localControlRequest)
    .where(
      and(
        eq(localControlRequest.id, c.req.param('id')),
        eq(localControlRequest.organizationId, organizationId),
      ),
    )
    .limit(1)

  const control = rows[0]
  if (!control) return c.json({ error: 'Control request not found' }, 404)

  return c.json({
    id: control.id,
    kind: control.kind,
    status: control.status,
    response: control.response,
    error: control.error,
    expiresAt: control.expiresAt.toISOString(),
    completedAt: control.completedAt?.toISOString() ?? null,
  })
})

/**
 * POST /sources — register a file the owner picked from a browse result.
 *
 * The dashboard already holds the root-relative path and the file identity from
 * the listing, so this needs no worker round trip. The identity is what detects
 * the file changing between registration and execution.
 */
dashboardApp.post('/sources', async (c) => {
  const access = await resolveImportAccess(c.var.runtime.env, c.var.session.userId)
  if (!access.ok) return c.json({ error: access.error }, access.status)
  const organizationId = access.organizationId
  if (!await localImportReady(c.var.runtime.env)) return c.json({ error: 'The local worker must be online and selected as the provider to import host folders' }, 503)

  const body = await readJson(c)
  const parsed = parseLocalSourceInput(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const source = await db
    .insert(transcodeSource)
    .values({
      organizationId,
      kind: 'local',
      rootName: parsed.value.rootName,
      relativePath: parsed.value.relativePath,
      fileName: parsed.value.fileName,
      identity: parsed.value.identity,
      sizeBytes: parsed.value.sizeBytes,
      availability: 'available',
      lastVerifiedAt: new Date(),
    })
    .returning({ id: transcodeSource.id })

  return c.json({
    sourceRef: source[0].id,
    rootName: parsed.value.rootName,
    relativePath: parsed.value.relativePath,
    fileName: parsed.value.fileName,
    sizeBytes: parsed.value.sizeBytes,
  })
})

/**
 * POST /imports — create videos and queue jobs for one or more sources.
 *
 * An idempotency key per source means a retried request (a double-click, a
 * network retry) does not produce a second encode of the same file. The key is
 * unique per organization in the database, so the guarantee holds across
 * concurrent requests rather than only within one process.
 */
dashboardApp.post('/imports', async (c) => {
  const access = await resolveImportAccess(c.var.runtime.env, c.var.session.userId)
  if (!access.ok) return c.json({ error: access.error }, access.status)
  const organizationId = access.organizationId
  if (!await localImportReady(c.var.runtime.env)) return c.json({ error: 'The local worker must be online and selected as the provider to import host folders' }, 503)

  const body = await readJson(c)
  const items = Array.isArray(body?.items) ? body.items : null
  if (!items || items.length === 0) return c.json({ error: 'items is required' }, 400)
  if (items.length > MAX_IMPORT_BATCH) {
    return c.json({ error: `at most ${MAX_IMPORT_BATCH} files per import` }, 400)
  }

  const imports: Array<Record<string, unknown>> = []
  for (const item of items as Array<Record<string, unknown>>) {
    const result = await createLocalImport({
      organizationId,
      userId: c.var.session.userId,
      sourceRef: typeof item?.sourceRef === 'string' ? item.sourceRef : '',
      title: typeof item?.title === 'string' ? item.title : undefined,
      playbackPolicy: item?.playbackPolicy === 'signed' ? 'signed' : 'public',
      options: (item?.processingOptions ?? {}) as Record<string, unknown>,
      idempotencyKey:
        typeof item?.idempotencyKey === 'string' ? item.idempotencyKey : null,
      generateSubtitle: item?.generateSubtitle === true,
      generateChapters: item?.generateChapters === true,
      env: c.var.runtime.env,
    })
    imports.push(result)
  }

  for (const entry of imports) {
    if (entry.deduplicated) continue
    dispatchWebhook(c.executionCtx, organizationId, 'video.processing', {
      videoId: entry.videoId,
      title: entry.title,
      provider: 'local',
    })
  }

  return c.json({ imports })
})

/** GET /jobs — queue state for the dashboard's activity view. */
dashboardApp.get('/jobs', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const rows = await db
    .select({
      jobId: transcodeJob.id,
      videoId: transcodeJob.videoId,
      title: video.title,
      status: video.status,
      state: transcodeJob.state,
      waitingReason: transcodeJob.waitingReason,
      provider: transcodeJob.provider,
      attempts: transcodeJob.attempts,
      maxAttempts: transcodeJob.maxAttempts,
      failureCode: transcodeJob.failureCode,
      lastError: transcodeJob.lastError,
      createdAt: transcodeJob.createdAt,
      updatedAt: transcodeJob.updatedAt,
      finishedAt: transcodeJob.finishedAt,
    })
    .from(transcodeJob)
    .innerJoin(video, eq(video.id, transcodeJob.videoId))
    .where(and(eq(transcodeJob.organizationId, organizationId), isNull(video.deletedAt)))
    .orderBy(desc(transcodeJob.createdAt))
    .limit(limit)

  return c.json({
    jobs: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    })),
  })
})

/** POST /jobs/:id/cancel — stop work and retire the attempt. */
dashboardApp.post('/jobs/:id/cancel', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const jobId = c.req.param('id')
  const rows = await db
    .select({ videoId: transcodeJob.videoId, attemptId: transcodeJob.attemptId })
    .from(transcodeJob)
    .where(and(eq(transcodeJob.id, jobId), eq(transcodeJob.organizationId, organizationId)))
    .limit(1)
  if (rows.length === 0) return c.json({ error: 'Job not found' }, 404)

  const body = await readJson(c)
  const { cancelJob } = await import('../lib/localJobQueue')
  const cancelled = await cancelJob(db, {
    jobId,
    organizationId,
    reason: typeof body?.reason === 'string' ? body.reason : undefined,
  })

  if (!cancelled) return c.json({ error: 'Job is already finished' }, 409)
  return c.json({ success: true, jobId, videoId: cancelled.videoId, status: 'cancelled' })
})

/** GET /health — shared worker status plus this organization's queue counts. */
dashboardApp.get('/health', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const [worker] = await db
    .select()
    .from(localWorker)
    .where(eq(localWorker.id, 'local'))
    .limit(1)
  const queue = await db
    .select({ state: transcodeJob.state, count: sql<number>`count(*)::int` })
    .from(transcodeJob)
    .where(eq(transcodeJob.organizationId, organizationId))
    .groupBy(transcodeJob.state)

  const active = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transcodeJob)
    .where(and(
      eq(transcodeJob.organizationId, organizationId),
      inArray(transcodeJob.state, ['claimed', 'running', 'publishing']),
    ))
  const online = Boolean(worker?.lastSeenAt && Date.now() - worker.lastSeenAt.getTime() <= 90_000)
  const capabilities = worker?.capabilities ?? {}

  return c.json({
    provider: c.var.runtime.config.transcodeProvider,
    worker: worker ? {
      online,
      lastSeenAt: worker.lastSeenAt?.toISOString() ?? null,
      hostname: worker.hostname,
      version: worker.workerVersion,
      capacityJobs: worker.capacityJobs,
      capacityRenditions: worker.capacityRenditions,
      activeJobs: Number(active[0]?.count ?? 0),
      encoders: Array.isArray(capabilities.encoders) ? capabilities.encoders : [],
    } : null,
    queue: Object.fromEntries(queue.map((row) => [row.state, row.count])),
    waitingReasons: WAITING_REASONS,
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Local worker source registration: /api/transcoder/v1/sources
// ═══════════════════════════════════════════════════════════════════════════════

export const localWorkerSourceApp = new Hono<{
  Bindings: Bindings
  Variables: LocalWorkerVariables
}>()
localWorkerSourceApp.use('/*', requireLocalWorker)

/**
 * POST / — the CLI registering a file it can already read.
 *
 * Only `rootName` + `relativePath` are accepted. A request carrying an absolute
 * host path is rejected outright rather than normalised: accepting one would
 * mean the API's stored "location" for a source could name a path the agent
 * never proved it had under a configured root.
 */
localWorkerSourceApp.post('/', async (c) => {
  if (!await localImportReady(c.var.runtime.env)) {
    return c.json({ error: 'The local worker must be online and selected as the provider to register host files' }, 503)
  }
  const importOrg = await configuredImportOrganization(c.var.runtime.env)
  if (!importOrg) return c.json({ error: localImportDisabledMessage }, 503)
  const body = await readJson(c)
  const parsed = parseLocalSourceInput(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const existing = await db
    .select({ id: transcodeSource.id })
    .from(transcodeSource)
    .where(
      and(
        eq(transcodeSource.organizationId, importOrg),
        eq(transcodeSource.kind, 'local'),
        eq(transcodeSource.rootName, parsed.value.rootName),
        eq(transcodeSource.relativePath, parsed.value.relativePath),
        eq(transcodeSource.identity, parsed.value.identity),
      ),
    )
    .limit(1)

  // Re-registering an unchanged file returns the same reference. A CLI import
  // retried after a lost response must not fork into two sources.
  if (existing[0]) {
    return c.json({ sourceRef: existing[0].id, reused: true, ...describeSource(parsed.value) })
  }

  const inserted = await db
    .insert(transcodeSource)
    .values({
      organizationId: importOrg,
      kind: 'local',
      rootName: parsed.value.rootName,
      relativePath: parsed.value.relativePath,
      fileName: parsed.value.fileName,
      identity: parsed.value.identity,
      sizeBytes: parsed.value.sizeBytes,
      availability: 'available',
      lastVerifiedAt: new Date(),
    })
    .returning({ id: transcodeSource.id })

  return c.json({ sourceRef: inserted[0].id, reused: false, ...describeSource(parsed.value) })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Automation: /v1/video/import-local
// ═══════════════════════════════════════════════════════════════════════════════

export const importLocalApp = new Hono<{
  Bindings: Bindings
  Variables: ApiKeyVariables
}>()

/**
 * POST /v1/video/import-local
 *
 * Deliberately accepts a **source reference** and nothing else that names bytes.
 * Not a path, not a URL: those would let an API key holder ask a transcoder to
 * read a file the owner never offered it.
 */
importLocalApp.post('/video/import-local', requireApiKey, async (c) => {
  const organizationId = c.var.organizationId
  const importOrg = await configuredImportOrganization(c.var.runtime.env)
  if (!importOrg) return c.json({ error: localImportDisabledMessage }, 503)
  if (organizationId !== importOrg) return c.json({ error: 'Host-folder imports are restricted to the configured LOCAL_IMPORT_ORG_ID organization' }, 403)
  const body = await readJson(c)
  const sourceRef = typeof body?.sourceRef === 'string' ? body.sourceRef : ''

  if (!sourceRef) {
    return c.json(
      {
        error:
          'sourceRef is required. Register the file first (`clipmux-transcoder import`, or the dashboard) to obtain one.',
      },
      400,
    )
  }

  const result = await createLocalImport({
    organizationId,
    userId: c.var.userId,
    sourceRef,
    title: typeof body?.title === 'string' ? body.title : undefined,
    playbackPolicy: body?.playbackPolicy === 'signed' ? 'signed' : 'public',
    options: (body?.processingOptions ?? {}) as Record<string, unknown>,
    idempotencyKey: typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : null,
    generateSubtitle: body?.generateSubtitle === true,
    generateChapters: body?.generateChapters === true,
    env: c.var.runtime.env,
  })

  if ('error' in result) {
    return c.json({ error: result.error }, (result.status ?? 400) as 400 | 403 | 404 | 409 | 503)
  }

  if (!result.deduplicated) {
    dispatchWebhook(c.executionCtx, organizationId, 'video.processing', {
      videoId: result.videoId,
      title: result.title,
      provider: 'local',
    })
  }

  return c.json(result, result.deduplicated ? 200 : 201)
})

// ═══════════════════════════════════════════════════════════════════════════════
// Shared import logic
// ═══════════════════════════════════════════════════════════════════════════════

export type LocalImportInput = {
  organizationId: string
  userId: string
  sourceRef: string
  title?: string
  playbackPolicy: 'public' | 'signed'
  options: Record<string, unknown>
  idempotencyKey: string | null
  generateSubtitle: boolean
  generateChapters: boolean
  env?: EnvLike
}

export type LocalImportResult =
  | {
      videoId: string
      jobId: string
      title: string
      sourceRef: string
      status: 'processing'
      waitingReason: string | null
      deduplicated: boolean
    }
  | { error: string; status?: number }

/**
 * Create the video, queue the job, and bind the source — idempotently.
 *
 * The dedupe check and the insert are separate statements, which is only safe
 * because the unique index on `(organization_id, idempotency_key)` is the real
 * guard: two concurrent requests both pass the check, one insert wins, and the
 * loser reads back the winner's job. A check alone would be a race.
 */
export async function createLocalImport(
  input: LocalImportInput,
): Promise<LocalImportResult> {
  if (!input.sourceRef) return { error: 'sourceRef is required', status: 400 }
  const importOrgId = input.env?.['LOCAL_IMPORT_ORG_ID']?.trim()
  if (!await localImportReady(input.env ?? {})) return { error: 'The local worker must be online and selected as the provider to import host folders', status: 503 }
  if (!importOrgId) return { error: localImportDisabledMessage, status: 503 }
  if (importOrgId !== input.organizationId) {
    return { error: 'Host-folder imports are restricted to the configured LOCAL_IMPORT_ORG_ID organization', status: 403 }
  }
  if (input.env?.['LOCAL_TRANSCODE_ENABLED']?.trim().toLowerCase() === 'false' || input.env?.['LOCAL_TRANSCODE_ENABLED']?.trim() === '0') {
    return { error: 'Local transcoding is disabled for new submissions', status: 503 }
  }

  const sourceRows = await db
    .select({
      id: transcodeSource.id,
      kind: transcodeSource.kind,
      fileName: transcodeSource.fileName,
      relativePath: transcodeSource.relativePath,
      availability: transcodeSource.availability,
    })
    .from(transcodeSource)
    .where(
      and(
        eq(transcodeSource.id, input.sourceRef),
        eq(transcodeSource.organizationId, input.organizationId),
      ),
    )
    .limit(1)

  const source = sourceRows[0]
  if (!source) {
    return { error: 'Source reference not found for this organization', status: 404 }
  }
  if (source.availability === 'missing') {
    return {
      error:
        'The source file is no longer where it was registered. Re-select it from the mounted folders.',
      status: 409,
    }
  }

  /**
   * Admission is serialized on the organization row before the key is consulted.
   *
   * Two concurrent requests carrying one key would otherwise both read "no
   * existing job" and both proceed. The unique index still decides — this makes
   * the loser's read see the winner's committed row, so it returns the winner's
   * job instead of failing after having already created a video.
   */
  const atomic = db as unknown as AtomicExecutor & AtomicBatchExecutor
  const existing = input.idempotencyKey
    ? await findExistingImport(input.organizationId, input.idempotencyKey)
    : null
  if (existing) return existing

  const title =
    input.title?.trim().slice(0, 300) ||
    source.fileName ||
    source.relativePath?.split('/').pop() ||
    'Untitled'

  const options = {
    ...input.options,
    // Provider is pinned here, at creation, so changing the installation default
    // never reroutes a job that already exists.
    provider: 'local',
    playbackPolicy: input.playbackPolicy,
    organizationId: input.organizationId,
    generateSubtitle: input.generateSubtitle,
    generateChapters: input.generateChapters,
  }

  let created: { jobId: string; videoId: string } | null
  try {
    if (!supportsAtomicBatch(atomic)) {
      // Without batch/transaction the lock and the insert cannot be ordered, so
      // the key check would race. The unique index still prevents a *duplicate
      // job*; refusing here keeps the promise that a caller gets the winner
      // rather than a confusing failure.
      throw new Error('import idempotency requires a driver with batch() or transaction()')
    }

    // Lock and create in **one** transaction. Taking the lock in a separate
    // transaction would release it before the insert, which is the race it is
    // meant to close.
    const results = await runAtomically(atomic, (handle) => {
      const scoped = handle as unknown as AtomicExecutor
      return [
        scoped.execute(
          sql`SELECT id FROM organization WHERE id = ${input.organizationId} FOR UPDATE`,
        ),
        scoped.execute(buildCreateLocalImportStatement({
          organizationId: input.organizationId,
          userId: input.userId,
          sourceId: source.id,
          title,
          playbackPolicy: input.playbackPolicy,
          generateSubtitle: input.generateSubtitle,
          generateChapters: input.generateChapters,
          options,
          idempotencyKey: input.idempotencyKey,
          provider: 'local',
        })),
      ]
    })

    const row = normalizeRows(results[results.length - 1])[0]
    created = row ? { jobId: String(row.id), videoId: String(row.video_id) } : null
  } catch (error) {
    // A unique-key violation means a concurrent request won. Returning the
    // winner's job is the whole point of an idempotency key; failing here is
    // what used to leave a duplicate video failed and its job queued.
    if (input.idempotencyKey && isUniqueViolation(error, 'idempotency')) {
      const winner = await findExistingImport(input.organizationId, input.idempotencyKey)
      if (winner) return winner
    }
    if (isUniqueViolation(error, 'one_runnable_per_video')) {
      // A runnable job already exists for this video: queueing a second one is
      // exactly what the index forbids.
      return {
        error: 'This video already has a transcode job in progress',
        status: 409,
      }
    }
    throw error
  }

  if (!created) {
    return { error: 'Could not queue the transcode job', status: 500 }
  }

  return {
    videoId: created.videoId,
    jobId: created.jobId,
    title,
    sourceRef: source.id,
    status: 'processing',
    waitingReason: null,
    deduplicated: false,
  }
}

/** The winner of an idempotency race, in the shape a caller expects back. */
async function findExistingImport(
  organizationId: string,
  idempotencyKey: string,
): Promise<LocalImportResult | null> {
  const rows = await db
    .select({
      jobId: transcodeJob.id,
      videoId: transcodeJob.videoId,
      waitingReason: transcodeJob.waitingReason,
      title: video.title,
      sourceId: transcodeJob.sourceId,
    })
    .from(transcodeJob)
    .innerJoin(video, eq(video.id, transcodeJob.videoId))
    .where(
      and(
        eq(transcodeJob.organizationId, organizationId),
        eq(transcodeJob.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return {
    videoId: row.videoId,
    jobId: row.jobId,
    title: row.title,
    sourceRef: row.sourceId ?? '',
    status: 'processing',
    waitingReason: row.waitingReason,
    deduplicated: true,
  }
}

/**
 * Does this error come from violating the given unique constraint?
 *
 * The check walks the `cause` chain and prefers the driver's SQLSTATE over the
 * message: drizzle wraps a driver error in a "Failed query" message that does
 * not carry the code, so matching on the outer message missed every unique
 * violation and turned a recoverable duplicate into a 500.
 */
function isUniqueViolation(error: unknown, fragment: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown }
    const code = typeof candidate.code === 'string' ? candidate.code : ''
    const message = typeof candidate.message === 'string' ? candidate.message : ''
    if (code === '23505' && message.includes(fragment)) return true
    // Some drivers put the constraint name in the message without the code.
    if (message.includes('23505') && message.includes(fragment)) return true
    if (message.includes('duplicate key') && message.includes(fragment)) return true
    current = candidate.cause
  }
  return false
}

// ── shared helpers ───────────────────────────────────────────────────────────

const localImportDisabledMessage =
  'Host-folder import is disabled. Set LOCAL_IMPORT_ORG_ID to an existing organization ID.'


async function localImportReady(env: EnvLike): Promise<boolean> {
  const provider = env['TRANSCODE_PROVIDER']?.trim().toLowerCase() ?? 'modal'
  if (provider !== 'local') return false
  if (env['LOCAL_TRANSCODE_ENABLED']?.trim().toLowerCase() === 'false' || env['LOCAL_TRANSCODE_ENABLED']?.trim() === '0') return false
  const [worker] = await db.select({ lastSeenAt: localWorker.lastSeenAt }).from(localWorker).where(eq(localWorker.id, 'local')).limit(1)
  return isLocalWorkerLive(worker?.lastSeenAt ?? null)
}

type ImportAccess =
  | { ok: true; organizationId: string }
  | { ok: false; error: string; status: 403 | 503 }

async function configuredImportOrganization(env: EnvLike): Promise<string | null> {
  const id = env['LOCAL_IMPORT_ORG_ID']?.trim()
  if (!id) return null
  const rows = await db.select({ id: organization.id }).from(organization).where(eq(organization.id, id)).limit(1)
  return rows[0]?.id ?? null
}

async function resolveImportAccess(env: EnvLike, userId: string): Promise<ImportAccess> {
  const organizationId = await configuredImportOrganization(env)
  if (!organizationId) return { ok: false, error: localImportDisabledMessage, status: 503 }
  const members = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
    .limit(1)
  if (!members[0] || !['owner', 'admin'].includes(members[0].role)) {
    return { ok: false, error: 'Only organization owners and admins may import host folders', status: 403 }
  }
  return { ok: true, organizationId }
}


type ParsedLocalSource = {
  rootName: string
  relativePath: string
  fileName: string
  identity: string
  sizeBytes: number | null
}

export function parseLocalSourceInput(
  body: Record<string, unknown>,
): { ok: true; value: ParsedLocalSource } | { ok: false; error: string } {
  const rootName = typeof body?.rootName === 'string' ? body.rootName.trim() : ''
  if (!rootName) return { ok: false, error: 'rootName is required' }

  const raw = typeof body?.relativePath === 'string' ? body.relativePath.trim() : ''
  if (!raw) return { ok: false, error: 'relativePath is required' }

  // Absolute host paths are refused rather than stripped: the stored location
  // must be one the agent proved it can reach under a configured root.
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return {
      ok: false,
      error: 'relativePath must be relative to the configured root, not an absolute path',
    }
  }
  if (raw.includes('\0') || raw.includes('\\')) {
    return { ok: false, error: 'relativePath contains an invalid character' }
  }

  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { ok: false, error: 'relativePath may not contain ".."' }
    segments.push(segment)
  }
  if (segments.length === 0) return { ok: false, error: 'relativePath is empty' }

  const relativePath = segments.join('/')
  const sizeRaw = Number(body?.sizeBytes)
  return {
    ok: true,
    value: {
      rootName,
      relativePath,
      fileName:
        typeof body?.fileName === 'string' && body.fileName.trim()
          ? body.fileName.trim().slice(0, 300)
          : segments[segments.length - 1],
      identity: typeof body?.identity === 'string' ? body.identity.slice(0, 200) : '',
      sizeBytes: Number.isFinite(sizeRaw) && sizeRaw >= 0 ? Math.floor(sizeRaw) : null,
    },
  }
}

function describeSource(value: ParsedLocalSource) {
  // Display form only: root name plus root-relative path. The absolute host path
  // was never sent, and is never echoed back.
  return {
    rootName: value.rootName,
    relativePath: value.relativePath,
    fileName: value.fileName,
    sizeBytes: value.sizeBytes,
  }
}

/**
 * Read a JSON body, tolerating a missing or malformed one.
 *
 * A dashboard request with no body is normal (a revoke, a cancel); a 400 there
 * would be a protocol error for a benign call.
 */
async function readJson(c: { req: { json: <T>() => Promise<T> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<unknown>()
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function apiBaseUrl(requestUrl: string, configuredBackendUrl: string | undefined): string {
  const configured = configuredBackendUrl
  if (configured) return configured.replace(/\/+$/, '')
  try {
    return new URL(requestUrl).origin
  } catch {
    return 'http://localhost:8787'
  }
}

export { notDeleted }
