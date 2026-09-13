/**
 * Local import: dashboard operations, agent-side source registration, and the
 * automation endpoint.
 *
 * Three audiences, three trust levels, one module — because they all end in the
 * same place (a video plus a queued job) and splitting them is how the dashboard
 * path and the CLI path drift apart on validation or on idempotency.
 *
 *   - `/api/transcoder/*`  session auth. Agents, pairings, folder browsing,
 *     imports, job control. Everything a signed-in owner does.
 *   - `/api/transcoder/v1/sources`  agent auth. The CLI registers a file it can
 *     already read. The agent supplies root + relative path; absolute host paths
 *     are never accepted and never stored.
 *   - `/v1/video/import-local`  API-key auth. Automation, accepting a
 *     **source reference** rather than a path or URL, so a compromised API key
 *     cannot ask the transcoder to read an arbitrary file.
 *
 * Browsing deserves a note. The browser never talks to the agent — the agent has
 * no listener by design. A browse is a row in `agent_control_request`, answered
 * on the agent's next poll; the dashboard polls for the answer. That also means
 * a browse can time out, which is reported as a timeout rather than as an empty
 * folder: "your machine did not answer" and "that folder is empty" are very
 * different messages.
 */

import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { requireApiKey } from '../middleware/apiKey'
import { requireAgent } from '../middleware/agentAuth'
import { db } from '../lib/database'
import {
  agentControlRequest,
  member,
  transcodeJob,
  transcodeSource,
  transcoderAgent,
  transcoderPairing,
  video,
} from '../db/schema'
import { notDeleted } from '../db/predicates'
import {
  generatePairingCode,
  hashAgentSecret,
  last4,
  newPairingId,
  PAIRING_CODE_TTL_MS,
} from '../lib/agentToken'
import { buildAgentHealth, type AgentRow } from '../lib/agentCapabilities'
import {
  buildCreateLocalImportStatement,
  DEFAULT_MAX_ATTEMPTS,
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
import type { AgentVariables } from '../middleware/agentAuth'
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

/** POST /pairings — mint a single-use code for a new agent. */
dashboardApp.post('/pairings', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const body = await readJson(c)
  const code = generatePairingCode()
  const pairingId = newPairingId()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS)

  await db.insert(transcoderPairing).values({
    id: pairingId,
    organizationId,
    codeHash: hashAgentSecret(code.replace(/[\s-]/g, '')),
    codeLast4: last4(code),
    createdBy: c.var.session.userId,
    suggestedName:
      typeof body?.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 120)
        : null,
    expiresAt,
  })

  // The plaintext code is returned exactly once: it is stored hashed, so this
  // response is the only time it can be read.
  return c.json({
    pairingId,
    code,
    expiresAt: expiresAt.toISOString(),
    command: `openvod-transcoder pair --api ${apiBaseUrl(c.req.url, c.var.runtime.env['BACKEND_URL'])} --code ${code}`,
  })
})

/** GET /agents — connectivity, capacity and capabilities per agent. */
dashboardApp.get('/agents', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const rows = await db
    .select({
      id: transcoderAgent.id,
      name: transcoderAgent.name,
      enabled: transcoderAgent.enabled,
      lastSeenAt: transcoderAgent.lastSeenAt,
      capabilities: transcoderAgent.capabilities,
      hostname: transcoderAgent.hostname,
      agentVersion: transcoderAgent.agentVersion,
      capacityJobs: transcoderAgent.capacityJobs,
      capacityRenditions: transcoderAgent.capacityRenditions,
      tokenLast4: transcoderAgent.tokenLast4,
      createdAt: transcoderAgent.createdAt,
      revokedAt: transcoderAgent.revokedAt,
    })
    .from(transcoderAgent)
    .where(eq(transcoderAgent.organizationId, organizationId))
    .orderBy(desc(transcoderAgent.createdAt))

  const health = buildAgentHealth(rows as AgentRow[])
  const byId = new Map(rows.map((row) => [row.id, row]))

  // Capacity use is read per agent in one query rather than N: the dashboard
  // polls this, and an N+1 here is N round trips per poll per agent.
  const active = await db
    .select({
      agentId: transcodeJob.agentId,
      active: sql<number>`count(*)::int`,
    })
    .from(transcodeJob)
    .where(
      and(
        eq(transcodeJob.organizationId, organizationId),
        inArray(transcodeJob.state, ['claimed', 'running', 'publishing']),
      ),
    )
    .groupBy(transcodeJob.agentId)
  const activeByAgent = new Map(active.map((row) => [row.agentId ?? '', row.active]))

  return c.json({
    agents: health.map((entry) => ({
      ...entry,
      tokenLast4: byId.get(entry.id)?.tokenLast4 ?? '****',
      createdAt: byId.get(entry.id)?.createdAt?.toISOString() ?? null,
      activeJobs: activeByAgent.get(entry.id) ?? 0,
    })),
  })
})

/** PATCH /agents/:id — rename, retune capacity, enable or disable. */
dashboardApp.patch('/agents/:id', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const agentId = c.req.param('id')
  const body = await readJson(c)

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (typeof body?.name === 'string' && body.name.trim()) {
    updates.name = body.name.trim().slice(0, 120)
  }
  if (typeof body?.enabled === 'boolean') {
    updates.enabled = body.enabled
    if (!body.enabled) updates.revokedAt = null
  }
  for (const key of ['capacityJobs', 'capacityRenditions'] as const) {
    if (body?.[key] === undefined) continue
    const value = Number(body[key])
    if (!Number.isInteger(value) || value < 1 || value > 64) {
      return c.json({ error: `${key} must be an integer between 1 and 64` }, 400)
    }
    updates[key] = value
  }

  const updated = await db
    .update(transcoderAgent)
    .set(updates)
    .where(
      and(eq(transcoderAgent.id, agentId), eq(transcoderAgent.organizationId, organizationId)),
    )
    .returning({ id: transcoderAgent.id })

  if (updated.length === 0) return c.json({ error: 'Agent not found' }, 404)
  return c.json({ success: true, agentId })
})

/** DELETE /agents/:id — revoke. The row survives for the audit trail. */
dashboardApp.delete('/agents/:id', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const agentId = c.req.param('id')
  const revoked = await db
    .update(transcoderAgent)
    .set({ enabled: false, revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(transcoderAgent.id, agentId), eq(transcoderAgent.organizationId, organizationId)),
    )
    .returning({ id: transcoderAgent.id })

  if (revoked.length === 0) return c.json({ error: 'Agent not found' }, 404)

  // Work bound to this agent cannot run anywhere else when its source is local,
  // so those jobs are left queued with an explicit reason rather than silently
  // failing. The owner decides whether to re-point them or cancel.
  await db
    .update(transcodeJob)
    .set({ waitingReason: 'agent-offline', updatedAt: new Date() })
    .where(
      and(
        eq(transcodeJob.organizationId, organizationId),
        eq(transcodeJob.agentId, agentId),
        eq(transcodeJob.state, 'queued'),
      ),
    )

  return c.json({ success: true, agentId, revoked: true })
})

/**
 * POST /agents/:id/browse — ask the agent for a directory listing.
 *
 * The result is fetched by a second call so a slow machine cannot hold the HTTP
 * request open past a Worker's limits. The control row carries the pagination
 * cursor and the root name; the response carries only root-relative paths.
 */
dashboardApp.post('/agents/:id/browse', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)
  const agentId = c.req.param('id')

  const agent = await loadAgent(organizationId, agentId)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  if (!agent.enabled) return c.json({ error: 'Agent is disabled' }, 409)

  const body = await readJson(c)
  const expiresAt = new Date(Date.now() + CONTROL_TIMEOUT_MS)

  const inserted = await db
    .insert(agentControlRequest)
    .values({
      organizationId,
      agentId,
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
    .returning({ id: agentControlRequest.id })

  return c.json({
    controlId: inserted[0].id,
    expiresAt: expiresAt.toISOString(),
    pollAfterMs: 500,
  })
})

/** GET /controls/:id — the answer to a browse or registration request. */
dashboardApp.get('/controls/:id', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const rows = await db
    .select()
    .from(agentControlRequest)
    .where(
      and(
        eq(agentControlRequest.id, c.req.param('id')),
        eq(agentControlRequest.organizationId, organizationId),
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
 * the listing, so this needs no agent round trip. The identity is what detects
 * the file changing between registration and execution.
 */
dashboardApp.post('/sources', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const body = await readJson(c)
  const parsed = parseLocalSourceInput(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const agent = await loadAgent(organizationId, parsed.value.agentId)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  const source = await db
    .insert(transcodeSource)
    .values({
      organizationId,
      kind: 'local',
      agentId: agent.id,
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
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

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
      provider: 'self-hosted',
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
      agentId: transcodeJob.agentId,
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

/**
 * GET /health — the authenticated capability view.
 *
 * Distinct from the public `/health/config`: this one names agents and reports
 * their capacity, which an unauthenticated caller has no business seeing.
 */
dashboardApp.get('/health', async (c) => {
  const organizationId = await activeOrganizationId(c)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  const agents = await db
    .select({
      id: transcoderAgent.id,
      name: transcoderAgent.name,
      enabled: transcoderAgent.enabled,
      lastSeenAt: transcoderAgent.lastSeenAt,
      capabilities: transcoderAgent.capabilities,
      hostname: transcoderAgent.hostname,
      agentVersion: transcoderAgent.agentVersion,
      capacityJobs: transcoderAgent.capacityJobs,
      capacityRenditions: transcoderAgent.capacityRenditions,
    })
    .from(transcoderAgent)
    .where(eq(transcoderAgent.organizationId, organizationId))

  const queue = await db
    .select({
      state: transcodeJob.state,
      count: sql<number>`count(*)::int`,
    })
    .from(transcodeJob)
    .where(eq(transcodeJob.organizationId, organizationId))
    .groupBy(transcodeJob.state)

  return c.json({
    agents: buildAgentHealth(agents as AgentRow[]),
    queue: Object.fromEntries(queue.map((row) => [row.state, row.count])),
    waitingReasons: WAITING_REASONS,
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Agent-side source registration: /api/transcoder/v1/sources
// ═══════════════════════════════════════════════════════════════════════════════

export const agentSourceApp = new Hono<{
  Bindings: Bindings
  Variables: AgentVariables
}>()
agentSourceApp.use('/*', requireAgent)

/**
 * POST / — the CLI registering a file it can already read.
 *
 * Only `rootName` + `relativePath` are accepted. A request carrying an absolute
 * host path is rejected outright rather than normalised: accepting one would
 * mean the API's stored "location" for a source could name a path the agent
 * never proved it had under a configured root.
 */
agentSourceApp.post('/', async (c) => {
  const agent = c.var.agent
  const body = await readJson(c)
  const parsed = parseLocalSourceInput({ ...body, agentId: agent.id })
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const existing = await db
    .select({ id: transcodeSource.id })
    .from(transcodeSource)
    .where(
      and(
        eq(transcodeSource.organizationId, agent.organizationId),
        eq(transcodeSource.agentId, agent.id),
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
      organizationId: agent.organizationId,
      kind: 'local',
      agentId: agent.id,
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
  const body = await readJson(c)
  const sourceRef = typeof body?.sourceRef === 'string' ? body.sourceRef : ''

  if (!sourceRef) {
    return c.json(
      {
        error:
          'sourceRef is required. Register the file first (agent `openvod-transcoder import`, or the dashboard) to obtain one.',
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
    return c.json({ error: result.error }, (result.status ?? 400) as 400 | 404 | 409)
  }

  if (!result.deduplicated) {
    dispatchWebhook(c.executionCtx, organizationId, 'video.processing', {
      videoId: result.videoId,
      title: result.title,
      provider: 'self-hosted',
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

  const sourceRows = await db
    .select({
      id: transcodeSource.id,
      kind: transcodeSource.kind,
      agentId: transcodeSource.agentId,
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
        'The source file is no longer where it was registered. Re-select it from the agent’s folders.',
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
    provider: 'self-hosted',
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
          agentId: source.kind === 'local' ? source.agentId : null,
          title,
          playbackPolicy: input.playbackPolicy,
          generateSubtitle: input.generateSubtitle,
          generateChapters: input.generateChapters,
          options,
          idempotencyKey: input.idempotencyKey,
          provider: 'self-hosted',
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
    waitingReason: source.kind === 'local' && !source.agentId ? 'no-eligible-agent' : null,
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

type ParsedLocalSource = {
  agentId: string
  rootName: string
  relativePath: string
  fileName: string
  identity: string
  sizeBytes: number | null
}

export function parseLocalSourceInput(
  body: Record<string, unknown>,
): { ok: true; value: ParsedLocalSource } | { ok: false; error: string } {
  const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
  if (!agentId) return { ok: false, error: 'agentId is required' }

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
      agentId,
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

async function loadAgent(organizationId: string, agentId: string) {
  const rows = await db
    .select({ id: transcoderAgent.id, enabled: transcoderAgent.enabled })
    .from(transcoderAgent)
    .where(
      and(eq(transcoderAgent.id, agentId), eq(transcoderAgent.organizationId, organizationId)),
    )
    .limit(1)
  return rows[0] ?? null
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
