/**
 * The self-hosted transcoder protocol — `/api/transcoder/v1`.
 *
 * The agent initiates every connection. There is no public listener on the
 * agent, no port forwarding, no tunnel: an owner who has to configure ingress
 * before their first video encodes will not finish the setup, and a listener on
 * a workstation is a much larger attack surface than an outbound poll.
 *
 * Consequences of that choice, which shape every route below:
 *
 * - **Requests are pull-based.** A folder browse is a *control request* written
 *   to the database, picked up on the agent's next poll, answered by a second
 *   call. The dashboard waits on the row, not on a socket to someone's laptop.
 * - **Nothing is trusted twice.** The agent's inventory gates what it may upload
 *   (`authorizeArtifactPath`), its completion is gated on verified objects, and
 *   the prefix it publishes under comes from the inventory the API recorded, not
 *   from the completion payload.
 * - **Every mutation is scoped to the attempt.** A job id alone is never enough:
 *   the attempt id must match, and the video row must still name that attempt.
 *   A superseded or expired worker gets a 409 and stops.
 * - **Leases, not deadlines.** A local CPU encode has no wall-clock bound, so
 *   liveness is the lease. Renewal happens on heartbeat *and* on every artifact
 *   grant, so a job that is uploading for an hour never loses ownership between
 *   heartbeats.
 */

import { Hono } from 'hono'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../lib/database'
import {
  agentControlRequest,
  artifactInventory,
  artifactInventoryItem,
  transcodeJob,
  transcodeSource,
  transcoderAgent,
  transcoderPairing,
  video,
} from '../db/schema'
import { getR2 } from '../utils/R2'
import { drainOutbox } from '../lib/webhookDelivery'
import {
  generateAgentToken,
  hashAgentSecret,
  last4,
  newAgentId,
  redeemPairingCode,
} from '../lib/agentToken'
import { validateCapabilities } from '../lib/agentCapabilities'
import {
  DEFAULT_JOB_LEASE_MS,
  JOB_STATE_CLAIMED,
  JOB_STATE_PUBLISHING,
  JOB_STATE_RUNNING,
  buildClaimNextJobStatement,
  buildSucceedJobStatement,
  claimJob,
  failJob,
  reclaimExpiredJobs,
  claimNextJob,
  readAttemptState,
  resumeOwnedAttempt,
  readOutstandingWork,
  setJobState,
  succeedJob,
} from '../lib/localJobQueue'
import {
  applyVerification,
  artifactKey,
  classifyVerification,
  markArtifactsUploaded,
  readInventoryArtifacts,
  readInventoryForAttempt,
  GRANT_BATCH_SIZE,
  VERIFY_BATCH_SIZE,
  readPendingArtifacts,
  readRemainingCount,
  readVerificationCandidates,
  registerInventoryPaged,
  supersedeInventories,
} from '../lib/artifactInventory'
import {
  attemptPrefix,
  finalizeAndSucceed,
  finalizeVideoFailure,
  finalizeVideoSuccess,
  parseCompletionPayload,
} from '../lib/lifecycleFinalize'
import { normalizeRows } from '../lib/atomicWrite'
import { organizationCapFromEnv } from '../lib/transcodeClaim'
import type { Bindings } from '../types'
import type { AgentVariables } from '../middleware/agentAuth'
import { requireAgent } from '../middleware/agentAuth'

export const TRANSCODER_PROTOCOL_VERSION = 1

/** Presigned transfer lifetime. Long enough for a large object, short enough to matter. */
export const TRANSFER_GRANT_TTL_SECONDS = 3600
/** Download grants are larger and slower: a 20 GB source over a home uplink. */
export const SOURCE_GRANT_TTL_SECONDS = 6 * 3600
/** A control request older than this is no longer interesting to answer. */
export const CONTROL_REQUEST_TTL_MS = 5 * 60_000

/**
 * Prefix used for self-hosted artifacts.
 *
 * Re-exported from the finalizer so the agent, the inventory and the publish
 * step cannot disagree about where the bytes live.
 */
export function outputPrefixFor(videoId: string, attemptId: string): string {
  return attemptPrefix(videoId, attemptId)
}

const app = new Hono<{ Bindings: Bindings; Variables: AgentVariables }>()

// ── pairing ──────────────────────────────────────────────────────────────────

/**
 * POST /pair — redeem a pairing code for a machine credential.
 *
 * Unauthenticated by necessity: this is how an agent gets its first credential.
 * The code is single-use, expiring and short, which is what keeps an
 * unauthenticated endpoint acceptable.
 */
app.post('/pair', async (c) => {
  const body = await readJson(c)
  if (!body || typeof body.code !== 'string') {
    return c.json({ error: 'code is required' }, 400)
  }

  const redemption = await redeemPairingCode(body.code)
  if (!redemption) {
    return c.json(
      { error: 'Pairing code is invalid, already used, or expired', code: 'PAIRING_FAILED' },
      401,
    )
  }

  const capabilityCheck = validateCapabilities(body.capabilities)
  if (!capabilityCheck.ok) {
    return c.json({ error: capabilityCheck.reason }, 400)
  }

  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 120)
      : (redemption.suggestedName ?? 'Self-hosted transcoder')

  const agentId = newAgentId()
  const token = generateAgentToken(agentId)

  const inserted = await db
    .insert(transcoderAgent)
    .values({
      id: agentId,
      organizationId: redemption.organizationId,
      name,
      tokenHash: hashAgentSecret(token),
      tokenLast4: last4(token),
      capabilities: capabilityCheck.value as Record<string, unknown>,
      agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion.slice(0, 60) : null,
      hostname: typeof body.hostname === 'string' ? body.hostname.slice(0, 200) : null,
      lastSeenAt: new Date(),
    })
    .onConflictDoNothing({ target: transcoderAgent.id })
    .returning({ id: transcoderAgent.id })

  if (inserted.length === 0) {
    return c.json({ error: 'Could not register agent' }, 500)
  }

  if (redemption.pairingId) {
    await db
      .update(transcoderPairing)
      .set({ consumedByAgentId: agentId })
      .where(eq(transcoderPairing.id, redemption.pairingId))
      .catch(() => {})
  }

  return c.json({
    protocolVersion: TRANSCODER_PROTOCOL_VERSION,
    agentId,
    token,
    organizationId: redemption.organizationId,
    name,
  })
})

/** POST /rotate — issue a fresh credential and invalidate the presented one. */
app.post('/rotate', requireAgent, async (c) => {
  const agent = c.var.agent
  const token = generateAgentToken(agent.id)
  await db
    .update(transcoderAgent)
    .set({
      tokenHash: hashAgentSecret(token),
      tokenLast4: last4(token),
      updatedAt: new Date(),
    })
    .where(eq(transcoderAgent.id, agent.id))
  return c.json({ token, tokenLast4: last4(token) })
})

/** POST /revoke — an agent retiring itself. The dashboard can do this too. */
app.post('/revoke', requireAgent, async (c) => {
  const agent = c.var.agent
  await db
    .update(transcoderAgent)
    .set({ enabled: false, revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(transcoderAgent.id, agent.id))
  return c.json({ revoked: true })
})

/** GET /whoami — lets `doctor` verify the credential without side effects. */
app.get('/whoami', requireAgent, async (c) => {
  const agent = c.var.agent
  return c.json({
    protocolVersion: TRANSCODER_PROTOCOL_VERSION,
    agentId: agent.id,
    organizationId: agent.organizationId,
    name: agent.name,
    capacityJobs: agent.capacityJobs,
    capacityRenditions: agent.capacityRenditions,
  })
})

// ── liveness and polling ─────────────────────────────────────────────────────

/** POST /heartbeat — capabilities, current progress, lease extension. */
app.post('/heartbeat', requireAgent, async (c) => {
  const agent = c.var.agent
  const body = await readJson(c)

  const capabilityCheck = validateCapabilities(body?.capabilities)
  if (!capabilityCheck.ok) {
    return c.json({ error: capabilityCheck.reason }, 400)
  }
  const hasCapabilities = Object.keys(capabilityCheck.value).length > 0

  await db
    .update(transcoderAgent)
    .set({
      lastSeenAt: new Date(),
      ...(hasCapabilities ? { capabilities: capabilityCheck.value as Record<string, unknown> } : {}),
      ...(typeof body?.agentVersion === 'string'
        ? { agentVersion: body.agentVersion.slice(0, 60) }
        : {}),
      ...(typeof body?.hostname === 'string'
        ? { hostname: body.hostname.slice(0, 200) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(transcoderAgent.id, agent.id))

  const progress = (body?.progress ?? null) as Record<string, unknown> | null
  const jobId = typeof progress?.jobId === 'string' ? progress.jobId : null
  const attemptId = typeof progress?.attemptId === 'string' ? progress.attemptId : null

  if (!jobId || !attemptId) {
    return c.json({ ok: true, leased: false })
  }

  // Extending the lease is the reason a beat exists. It is guarded on the
  // *video* row's attempt id rather than the job's, because that is the value
  // the completion path checks — if they could disagree, a beat could keep alive
  // an attempt that can no longer publish.
  const leaseMs = DEFAULT_JOB_LEASE_MS
  const renewed = normalizeRows(
    await db.execute(sql`
      WITH owning AS (
        SELECT j.id, j.video_id
        FROM transcode_job AS j
        WHERE j.id = ${jobId}::uuid
          AND j.attempt_id = ${attemptId}
          AND j.lease_owner = ${agent.id}
          AND j.state IN ('claimed', 'running', 'publishing')
      ),
      beat AS (
        UPDATE video
        SET last_heartbeat_at = now(),
            transcode_lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
            updated_at = now()
        WHERE id IN (SELECT video_id FROM owning)
          AND deleted_at IS NULL
          AND transcode_attempt_id = ${attemptId}
          AND status = 'processing'
        RETURNING id
      )
      UPDATE transcode_job AS j
      SET lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
          state = CASE WHEN j.state = 'claimed' THEN 'running' ELSE j.state END,
          updated_at = now()
      WHERE j.id IN (SELECT id FROM owning)
        AND EXISTS (SELECT 1 FROM beat)
      RETURNING j.id, j.state
    `),
  )

  if (renewed.length === 0) {
    // Ownership is gone. The agent must stop *before* the lease expires rather
    // than finish and upload into a prefix a newer attempt may now own.
    const state = await readAttemptState(db, { jobId, attemptId })
    return c.json({
      ok: true,
      leased: false,
      stop: true,
      reason: state.ownsAttempt ? 'lease-lost' : 'superseded',
      jobState: state.state,
      videoStatus: state.videoStatus,
    })
  }

  // The stage/progress the agent reports is stored as video metadata so the
  // dashboard can render it without knowing the agent protocol.
  const stage = typeof progress?.stage === 'string' ? progress.stage : null
  const fraction = typeof progress?.progress === 'number' ? progress.progress : null
  if (stage) {
    await db
      .update(video)
      .set({
        metadata: sql`jsonb_set(
          jsonb_set(
            COALESCE(metadata, '{}')::jsonb,
            '{processing}',
            ${JSON.stringify({
              stage,
              progress: fraction,
              renditions: progress?.renditions ?? null,
              speed: progress?.speed ?? null,
              updated_at: new Date().toISOString(),
            })}::jsonb,
            true
          ),
          '{waiting_reason}',
          'null'::jsonb,
          true
        )::text`,
      })
      .where(and(eq(video.id, (await jobVideoId(jobId)) ?? ''), isNull(video.deletedAt)))
      .catch(() => {})
  }

  return c.json({ ok: true, leased: true, jobState: String(renewed[0]?.state ?? 'running') })
})

/** GET /poll — pending control requests and how much work this agent holds. */
app.get('/poll', requireAgent, async (c) => {
  const agent = c.var.agent

  const controls = await db
    .select({
      id: agentControlRequest.id,
      kind: agentControlRequest.kind,
      request: agentControlRequest.request,
      expiresAt: agentControlRequest.expiresAt,
    })
    .from(agentControlRequest)
    .where(
      and(
        eq(agentControlRequest.agentId, agent.id),
        eq(agentControlRequest.status, 'pending'),
        sql`${agentControlRequest.expiresAt} > now()`,
      ),
    )
    .orderBy(agentControlRequest.createdAt)
    .limit(10)

  const outstanding = await readOutstandingWork(db, { agentId: agent.id })

  // Expired requests are retired here rather than by a sweeper: the only moment
  // anybody cares is when the agent asks.
  c.executionCtx?.waitUntil?.(
    db
      .update(agentControlRequest)
      .set({ status: 'expired' })
      .where(
        and(
          eq(agentControlRequest.agentId, agent.id),
          eq(agentControlRequest.status, 'pending'),
          lt(agentControlRequest.expiresAt, new Date()),
        ),
      )
      .catch(() => {}),
  )

  return c.json({
    protocolVersion: TRANSCODER_PROTOCOL_VERSION,
    controls: controls.map((control) => ({
      id: control.id,
      kind: control.kind,
      request: control.request,
      expiresAt: control.expiresAt.toISOString(),
    })),
    outstanding,
    capacity: {
      jobs: agent.capacityJobs,
      renditions: agent.capacityRenditions,
      free: Math.max(0, agent.capacityJobs - outstanding.activeJobs),
    },
  })
})

/** POST /control/:id — the agent's answer to a browse or registration request. */
app.post('/control/:id', requireAgent, async (c) => {
  const agent = c.var.agent
  const controlId = c.req.param('id')
  const body = await readJson(c)

  const ok = body?.ok !== false
  const updated = await db
    .update(agentControlRequest)
    .set({
      status: ok ? 'completed' : 'failed',
      response: (body?.response ?? null) as Record<string, unknown> | null,
      error: typeof body?.error === 'string' ? body.error.slice(0, 1000) : null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(agentControlRequest.id, controlId),
        eq(agentControlRequest.agentId, agent.id),
        inArray(agentControlRequest.status, ['pending', 'delivered']),
      ),
    )
    .returning({ id: agentControlRequest.id })

  if (updated.length === 0) {
    return c.json({ error: 'Control request not found or already answered' }, 404)
  }
  return c.json({ ok: true })
})

// ── work claiming ────────────────────────────────────────────────────────────

/**
 * POST /claim — take the oldest eligible job, if there is capacity.
 *
 * A `jobId` may be supplied to claim one specific job; the eligibility rules
 * (source affinity, availability, this agent's own capacity) still apply, so a
 * named claim cannot jump the queue into a job the agent should not run.
 */
app.post('/claim', requireAgent, async (c) => {
  const agent = c.var.agent
  const body = await readJson(c)
  const jobId = typeof body?.jobId === 'string' ? body.jobId : null
  const leaseMs = typeof body?.leaseMs === 'number' ? body.leaseMs : DEFAULT_JOB_LEASE_MS

  if (jobId) {
    const attemptId =
      typeof body?.attemptId === 'string' && body.attemptId
        ? body.attemptId
        : `${agent.id}:${crypto.randomUUID()}`
    // The organization is required, not optional: a named claim that skipped it
    // let any tenant's agent take an `r2`-source job it could name, because such
    // a job has `agent_id = NULL` by design.
    const claimed = await claimJob(db, {
      jobId,
      agentId: agent.id,
      organizationId: agent.organizationId,
      attemptId,
      leaseMs,
      agentCapacity: agent.capacityJobs,
      organizationCapacity: organizationCapFromEnv(c.env as Record<string, unknown>),
    })
    if (!claimed) {
      return c.json({ claim: null, reason: 'not-eligible' })
    }
    return c.json({ protocolVersion: TRANSCODER_PROTOCOL_VERSION, claim: await claimPayload(claimed) })
  }

  const claimed = await claimNextForAgent({
    agentId: agent.id,
    organizationId: agent.organizationId,
    capacity: agent.capacityJobs,
    organizationCapacity: organizationCapFromEnv(c.env as Record<string, unknown>),
    leaseMs,
  })
  if (!claimed) {
    return c.json({ claim: null, reason: 'no-work' })
  }
  return c.json({ protocolVersion: TRANSCODER_PROTOCOL_VERSION, claim: await claimPayload(claimed) })
})

/**
 * GET /jobs — the jobs this agent's organization has queued or running.
 *
 * Organization-scoped, and deliberately narrow: the CLI needs to answer "what is
 * this machine working on?", which does not require titles, playback URLs or
 * anything about another tenant. A separate route from the dashboard's, because
 * the two are authorized differently and merging them would mean one of them
 * carrying a scope check the other does not need.
 */
app.get('/jobs', requireAgent, async (c) => {
  const agent = c.var.agent
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 25))

  const rows = await db
    .select({
      jobId: transcodeJob.id,
      videoId: transcodeJob.videoId,
      state: transcodeJob.state,
      waitingReason: transcodeJob.waitingReason,
      attempts: transcodeJob.attempts,
      maxAttempts: transcodeJob.maxAttempts,
      failureCode: transcodeJob.failureCode,
      lastError: transcodeJob.lastError,
      agentId: transcodeJob.agentId,
      createdAt: transcodeJob.createdAt,
      updatedAt: transcodeJob.updatedAt,
    })
    .from(transcodeJob)
    .where(eq(transcodeJob.organizationId, agent.organizationId))
    .orderBy(sql`${transcodeJob.createdAt} DESC`)
    .limit(limit)

  return c.json({
    jobs: rows.map((row) => ({
      ...row,
      mine: row.agentId === agent.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  })
})

/**
 * POST /jobs/:id/cancel — stop a job in this agent's organization.
 *
 * Allowed for an agent credential because the alternative is worse: an operator
 * watching a job run on a headless box has no session cookie there, and the
 * "correct" answer would be to walk to another machine. The scope is the same
 * organization the agent already serves, and cancelling is never destructive of
 * the owner's original file.
 */
app.post('/jobs/:id/cancel', requireAgent, async (c) => {
  const agent = c.var.agent
  const jobId = c.req.param('id')
  const body = await readJson(c)

  const { cancelJob } = await import('../lib/localJobQueue')
  const cancelled = await cancelJob(db, {
    jobId,
    organizationId: agent.organizationId,
    reason: typeof body?.reason === 'string' ? body.reason : 'cancelled from the agent CLI',
  })

  if (!cancelled) return c.json({ error: 'Job not found or already finished' }, 404)
  return c.json({ success: true, jobId, videoId: cancelled.videoId, status: 'cancelled' })
})

/**
 * POST /jobs/:id/retry — re-queue a failed job.
 *
 * Only a job in a terminal state, and only within the organization. The source
 * is unchanged, so a local job returns to the same agent that holds the file —
 * which is the whole point: retrying must not silently move work to a machine
 * that cannot read it.
 */
app.post('/jobs/:id/retry', requireAgent, async (c) => {
  const agent = c.var.agent
  const jobId = c.req.param('id')

  const rows = await db
    .select({
      jobId: transcodeJob.id,
      videoId: transcodeJob.videoId,
      state: transcodeJob.state,
      agentId: transcodeJob.agentId,
    })
    .from(transcodeJob)
    .where(
      and(
        eq(transcodeJob.id, jobId),
        eq(transcodeJob.organizationId, agent.organizationId),
      ),
    )
    .limit(1)

  const job = rows[0]
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (!['failed', 'cancelled'].includes(job.state)) {
    return c.json({ error: `Only failed or cancelled jobs can be retried (current: ${job.state})` }, 409)
  }

  const requeued = normalizeRows(
    await db.execute(sql`
      WITH requeued AS (
        UPDATE transcode_job
        SET state = 'queued',
            attempts = 0,
            failure_code = NULL,
            last_error = NULL,
            waiting_reason = NULL,
            next_attempt_at = NULL,
            attempt_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            finished_at = NULL,
            updated_at = now()
        WHERE id = ${jobId}::uuid
          AND organization_id = ${agent.organizationId}
          AND state IN ('failed', 'cancelled')
        RETURNING id, video_id
      ),
      reopened AS (
        UPDATE video
        SET status = 'processing',
            failure_code = NULL,
            processing_started_at = now(),
            transcode_attempt_id = NULL,
            transcode_lease_expires_at = NULL,
            updated_at = now()
        WHERE id IN (SELECT video_id FROM requeued)
          AND deleted_at IS NULL
        RETURNING id
      )
      SELECT id, video_id FROM requeued
    `),
  )

  if (requeued.length === 0) {
    return c.json({ error: 'Job could not be re-queued' }, 409)
  }

  return c.json({ success: true, jobId, videoId: job.videoId, status: 'queued' })
})

/** POST /reconcile — what should this agent be doing after a restart? */
app.post('/reconcile', requireAgent, async (c) => {
  const agent = c.var.agent
  const body = await readJson(c)
  const attempts = Array.isArray(body?.attempts) ? body.attempts : []

  const decisions: Array<Record<string, unknown>> = []
  for (const entry of attempts.slice(0, 100)) {
    const jobId = typeof (entry as Record<string, unknown>)?.jobId === 'string'
      ? ((entry as Record<string, unknown>).jobId as string)
      : null
    const attemptId = typeof (entry as Record<string, unknown>)?.attemptId === 'string'
      ? ((entry as Record<string, unknown>).attemptId as string)
      : null
    if (!jobId || !attemptId) continue
    const state = await readAttemptState(db, { jobId, attemptId })
    decisions.push({
      jobId,
      attemptId,
      resume: state.ownsAttempt && state.state !== null && state.state !== 'queued',
      reason: state.ownsAttempt ? null : 'superseded',
      videoStatus: state.videoStatus,
    })
  }

  // Expired leases on this agent are reclaimed here too, so a restart does not
  // have to wait for the maintenance sweeper to become eligible again.
  const reclaimed = await reclaimExpiredJobs(db, { limit: 25 })

  return c.json({ decisions, reclaimed: reclaimed.length })
})

// ── transfers ────────────────────────────────────────────────────────────────

/**
 * POST /sources/:id/grant — a short-lived download URL for an r2/url source.
 *
 * Local sources are never granted this way: they are read from the agent's own
 * filesystem, and handing out a URL for a path on someone's laptop is not a thing
 * that exists.
 */
app.post('/sources/:id/grant', requireAgent, async (c) => {
  const agent = c.var.agent
  const sourceId = c.req.param('id')

  const rows = await db
    .select()
    .from(transcodeSource)
    .where(
      and(
        eq(transcodeSource.id, sourceId),
        eq(transcodeSource.organizationId, agent.organizationId),
      ),
    )
    .limit(1)
  const source = rows[0]
  if (!source) return c.json({ error: 'Source not found' }, 404)

  if (source.kind === 'local') {
    return c.json(
      {
        error: 'Local sources are read from the agent that holds them',
        code: 'SOURCE_IS_LOCAL',
      },
      400,
    )
  }

  if (source.kind === 'url') {
    // A one-off URL source is fetched directly; the API does not proxy it.
    return c.json({ kind: 'url', url: source.inputUrl, expiresAt: null })
  }

  const bucket = source.r2Bucket
  const key = source.r2Key
  if (!bucket || !key) {
    return c.json({ error: 'Source is missing its object location' }, 409)
  }

  const url = await getSignedUrl(
    getR2(c.env),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: SOURCE_GRANT_TTL_SECONDS },
  )

  return c.json({
    kind: 'r2',
    url,
    expiresAt: new Date(Date.now() + SOURCE_GRANT_TTL_SECONDS * 1000).toISOString(),
    sizeBytes: source.sizeBytes ?? null,
  })
})

/**
 * POST /jobs/:id/inventory — declare the artifacts this attempt will upload.
 *
 * The prefix is chosen by the API, never accepted from the agent, and the
 * attempt must still own the job. Both are what stop an agent from writing into
 * another attempt's directory.
 */
app.post('/jobs/:id/inventory', requireAgent, async (c) => {
  const agent = c.var.agent
  const jobId = c.req.param('id')
  const body = await readJson(c)

  const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : null
  if (!artifacts) return c.json({ error: 'artifacts must be an array' }, 400)

  const job = await requireOwnedJob(agent.id, jobId)
  if (!job) return c.json({ error: 'Job not found or not owned by this agent' }, 404)

  const prefix = outputPrefixFor(job.videoId, job.attemptId)
  let registered: { inventoryId: string; items: number; status: string }
  try {
    // Paged: a two-hour 1080p ladder is roughly 9,000 objects, and a single
    // request carrying them would exceed every request budget in the stack.
    registered = await registerInventoryPaged(db, {
      videoId: job.videoId,
      organizationId: agent.organizationId,
      jobId: job.jobId,
      attemptId: job.attemptId,
      prefix,
      artifacts: artifacts as Array<{ path: string; size: number; checksum?: string; role?: string }>,
    })
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid inventory' },
      400,
    )
  }

  return c.json({
    inventoryId: registered.inventoryId,
    items: registered.items,
    status: registered.status,
    prefix,
  })
})

/**
 * POST /inventories/:id/grants — fresh presigned PUT URLs, bounded and renewable.
 *
 * Renewal is the mechanism that makes a long upload survivable without a
 * permanent credential: the URL expires, the agent asks again, and the API
 * refuses once the attempt is no longer authorized. It also extends the lease,
 * because a job that spends an hour uploading must not lose ownership while it
 * does.
 */
app.post('/inventories/:id/grants', requireAgent, async (c) => {
  const agent = c.var.agent
  const inventoryId = c.req.param('id')

  const inventory = await loadAuthorizedInventory(agent.id, inventoryId)
  if (!inventory) {
    // Unknown, superseded, deleted video, stale lease or a newer attempt: all
    // the same answer to the agent, which is to stop.
    return c.json({ error: 'Inventory not found or not owned by this agent', code: 'SUPERSEDED' }, 409)
  }

  const body = await readJson(c)
  const limit = Math.min(
    GRANT_BATCH_SIZE,
    Math.max(1, Number(body.limit) || GRANT_BATCH_SIZE),
  )

  const pending = await readPendingArtifacts(db, {
    inventoryId,
    attemptId: inventory.attemptId,
    limit,
  })
  const remaining = await readRemainingCount(db, { inventoryId })

  const bucket = transcodedBucketName(c.env)
  if (!bucket) return c.json({ error: 'Transcoded bucket is not configured' }, 503)

  const client = getR2(c.env)
  const grants = await Promise.all(
    pending.map(async (artifact) => {
      const key = artifactKey(inventory.prefix, artifact.path)
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentTypeFor(artifact.path),
        CacheControl: cacheControlFor(artifact.path),
        Metadata: {
          'video-id': inventory.videoId,
          'organization-id': agent.organizationId,
          'playback-policy': inventory.playbackPolicy,
          'attempt-id': inventory.attemptId,
        },
        ContentLength: artifact.sizeBytes,
      })
      return {
        path: artifact.path,
        url: await getSignedUrl(client, command, { expiresIn: TRANSFER_GRANT_TTL_SECONDS }),
      }
    }),
  )

  // Uploading is proof of life for the attempt as much as a heartbeat is. If the
  // lease cannot be extended, the grants are withheld rather than handed over:
  // a URL issued to an attempt that no longer owns the job authorizes a write
  // into a prefix a newer attempt may be publishing.
  const extended = await extendLease(inventory.videoId, inventory.attemptId, agent.id)
  if (!extended) {
    return c.json({ error: 'Attempt is no longer current', code: 'SUPERSEDED' }, 409)
  }

  return c.json({
    grants,
    remaining: Math.max(0, remaining - grants.length),
    expiresAt: new Date(Date.now() + TRANSFER_GRANT_TTL_SECONDS * 1000).toISOString(),
  })
})

/** POST /inventories/:id/uploaded — the agent's claim that paths are in place. */
app.post('/inventories/:id/uploaded', requireAgent, async (c) => {
  const agent = c.var.agent
  const inventoryId = c.req.param('id')
  const inventory = await loadAuthorizedInventory(agent.id, inventoryId)
  if (!inventory) return c.json({ error: 'Inventory not found or not owned by this agent' }, 404)
  if (inventory.status === 'superseded') {
    return c.json({ error: 'Attempt has been superseded', code: 'SUPERSEDED' }, 409)
  }

  const body = await readJson(c)
  const paths = Array.isArray(body?.paths) ? (body.paths as string[]) : []
  if (paths.length === 0) return c.json({ error: 'paths must be a non-empty array' }, 400)

  const checksums: Record<string, string> = {}
  if (body?.checksums && typeof body.checksums === 'object') {
    for (const [path, value] of Object.entries(body.checksums as Record<string, unknown>)) {
      if (typeof value === 'string') checksums[path] = value
    }
  }

  const updated = await markArtifactsUploaded(db, { inventoryId, paths, checksums })
  const extended = await extendLease(inventory.videoId, inventory.attemptId, agent.id)
  if (!extended) {
    return c.json({ error: 'Attempt is no longer current', code: 'SUPERSEDED' }, 409)
  }
  return c.json({ updated })
})

/**
 * POST /inventories/:id/verify — confirm the objects exist, then allow publish.
 *
 * Verification is the API's job, not the agent's: an agent reporting "I uploaded
 * it" is a claim about its own success, and the whole point of the gate is not to
 * take that on trust. Sizes come from HEAD; checksums are compared only against
 * what the agent itself recorded, because an object store's multipart ETag is
 * not a content hash.
 */
app.post('/inventories/:id/verify', requireAgent, async (c) => {
  const agent = c.var.agent
  const inventoryId = c.req.param('id')
  const inventory = await loadAuthorizedInventory(agent.id, inventoryId)
  if (!inventory) {
    return c.json({ error: 'Inventory not found or not owned by this agent', code: 'SUPERSEDED' }, 409)
  }

  const body = await readJson(c)
  const limit = Math.min(
    VERIFY_BATCH_SIZE,
    Math.max(1, Number(body.limit) || VERIFY_BATCH_SIZE),
  )

  const bucket = transcodedBucketName(c.env)
  if (!bucket) return c.json({ error: 'Transcoded bucket is not configured' }, 503)

  // Bounded per call. The agent loops until nothing is left: one request for a
  // 9,000-object inventory would exceed the Worker's subrequest and CPU budgets
  // and time out, leaving an inventory that is neither verified nor failed.
  const candidates = await readVerificationCandidates(db, { inventoryId, limit })
  const client = getR2(c.env)
  const observed = new Map<string, number | null>()

  for (const batch of chunk(candidates, 25)) {
    await Promise.all(
      batch.map(async (artifact) => {
        const key = artifactKey(inventory.prefix, artifact.path)
        try {
          const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
          observed.set(
            artifact.path,
            typeof head.ContentLength === 'number' ? head.ContentLength : null,
          )
        } catch {
          observed.set(artifact.path, null)
        }
      }),
    )
  }

  const { verified, failed } = classifyVerification(candidates, observed)
  const result = await applyVerification(db, { inventoryId, verified, failed })

  const extended = await extendLease(inventory.videoId, inventory.attemptId, agent.id)
  if (!extended) {
    return c.json({ error: 'Attempt is no longer current', code: 'SUPERSEDED' }, 409)
  }

  const remaining = await readRemainingCount(db, { inventoryId })

  return c.json({
    status: result?.status ?? 'registering',
    verified: result?.verified ?? 0,
    total: result?.total ?? 0,
    remaining,
    failures: failed,
  })
})

/**
 * POST /jobs/:id/resume — re-acquire an attempt this agent already owns.
 *
 * A restarted agent must be able to *finish* an accepted attempt, not merely
 * learn that it is still valid. Reporting `resume: true` and then claiming other
 * work leaves the accepted attempt holding a lease until it expires, during
 * which its video is stuck and its capacity slot is consumed — the recovery path
 * existed on paper and did nothing.
 *
 * Refused unless the attempt still owns both rows, which is the same authority
 * the completion path checks.
 */
app.post('/jobs/:id/resume', requireAgent, async (c) => {
  const agent = c.var.agent
  const jobId = c.req.param('id')
  const body = await readJson(c)
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId : ''
  if (!attemptId) return c.json({ error: 'attemptId is required' }, 400)

  const job = await resumeOwnedAttempt(db, {
    jobId,
    attemptId,
    agentId: agent.id,
  })
  if (!job) {
    return c.json({ error: 'Attempt is no longer current', code: 'SUPERSEDED' }, 409)
  }

  return c.json({ claim: await claimPayload(job) })
})

// ── completion ───────────────────────────────────────────────────────────────

/**
 * POST /jobs/:id/complete — the attempt succeeded.
 *
 * Two gates before anything is published: the attempt must still own the video
 * row, and the inventory must be fully verified. Both are guards inside the
 * publication statement, so a completion that loses either race changes nothing.
 *
 * **The video/outbox write and the job write are one transaction.** Split across
 * two statements they had a window: a crash after publication left the video
 * `ready` and the job `publishing`, and the replay then found a ready video and
 * a job the liveness lookup refused to return — a permanently stuck job over a
 * video that was actually fine.
 *
 * **A replay is answered with the recorded receipt.** The agent replays exactly
 * when it did not see the response, so the one case where it asks again is the
 * case where "already done" must be a success, not a 404.
 */
app.post('/jobs/:id/complete', requireAgent, async (c) => {
  const agent = c.var.agent
  const jobId = c.req.param('id')
  const body = await readJson(c)
  const attemptId = typeof body?.attemptId === 'string' ? body.attemptId : null
  const payload = (body?.payload ?? null) as Record<string, unknown> | null

  if (!attemptId || !payload) {
    return c.json({ error: 'attemptId and payload are required' }, 400)
  }

  const existing = await loadJobForCompletion(agent.organizationId, jobId)
  if (!existing) return c.json({ error: 'Job not found' }, 404)

  // ── replay ───────────────────────────────────────────────────────────────
  if (existing.state === 'succeeded') {
    if (existing.attemptId && existing.attemptId !== attemptId) {
      // A different attempt's completion for a job that already finished. The
      // recorded receipt stands; this one is stale.
      return c.json({ applied: false, reason: 'superseded', receipt: existing.completionReceipt }, 409)
    }
    return c.json(
      existing.completionReceipt
        ? { ...existing.completionReceipt, applied: true, replayed: true }
        : { applied: true, replayed: true, status: 'ready', videoId: existing.videoId },
    )
  }

  // ── repair ───────────────────────────────────────────────────────────────
  // A job left mid-publication by an older build: the video is already ready
  // under this attempt, so the work is done and only the job row is behind.
  const videoRows = await db
    .select({
      status: video.status,
      title: video.title,
      metadata: video.metadata,
      transcodeAttemptId: video.transcodeAttemptId,
      hlsUrl: video.hlsUrl,
    })
    .from(video)
    .where(eq(video.id, existing.videoId))
    .limit(1)
  const videoRecord = videoRows[0]
  if (!videoRecord) return c.json({ error: 'Video not found' }, 404)

  if (
    videoRecord.status === 'ready' &&
    videoRecord.transcodeAttemptId === null &&
    existing.attemptId === attemptId
  ) {
    await succeedJob(db, { jobId, attemptId })
    const receipt = {
      applied: true,
      repaired: true,
      status: 'ready',
      videoId: existing.videoId,
      hlsUrl: videoRecord.hlsUrl,
    }
    await recordCompletionReceipt(jobId, receipt)
    return c.json(receipt)
  }

  const job = await loadJobForAgent(agent.id, jobId)
  if (!job) return c.json({ error: 'Job not found or not owned by this agent', code: 'SUPERSEDED' }, 409)
  if (job.attemptId !== attemptId) {
    return c.json({ error: 'Attempt is no longer current', code: 'SUPERSEDED' }, 409)
  }

  const inventory = await readInventoryForAttempt(db, {
    videoId: job.videoId,
    attemptId,
  })
  if (!inventory || inventory.status !== 'verified') {
    return c.json(
      {
        error: 'Artifact inventory is not verified',
        code: 'INVENTORY_UNVERIFIED',
        status: inventory?.status ?? 'missing',
        verified: inventory?.verified ?? 0,
        total: inventory?.total ?? 0,
      },
      409,
    )
  }

  const preview = parseCompletionPayload(payload, {
    outputPrefix: inventory.prefix,
    deliveryBaseUrl: deliveryBaseUrl(c.env),
    prevMetadata: safeJson(videoRecord.metadata),
  })

  // Video/outbox and job, atomically. See the note above on the window this
  // closes.
  const outcome = await finalizeAndSucceed(
    db,
    {
      videoId: job.videoId,
      organizationId: agent.organizationId,
      title: videoRecord.title,
      attemptId,
      jobId,
      payload,
      outputPrefix: inventory.prefix,
      deliveryBaseUrl: deliveryBaseUrl(c.env),
      prevMetadata: safeJson(videoRecord.metadata),
      requireVerifiedInventory: true,
      publishedPrefix: inventory.prefix,
    },
    (id, att) => buildSucceedJobStatement({ jobId: id, attemptId: att }),
  )

  if (!outcome.applied) {
    return c.json({ applied: false, reason: 'transition-not-applied', hlsUrl: preview.hlsUrl }, 409)
  }

  const receipt = {
    applied: true,
    status: 'ready',
    videoId: job.videoId,
    hlsUrl: outcome.hlsUrl,
    thumbnailUrl: outcome.thumbnailUrl,
    subtitleUrl: outcome.subtitleUrl,
    eventId: outcome.eventId,
  }
  await recordCompletionReceipt(jobId, receipt)
  c.executionCtx?.waitUntil?.(drainOutbox({ eventIds: [outcome.eventId] }).catch(() => {}))

  return c.json(receipt)
})

/** Persist the receipt a replay is answered with. Best-effort, never fatal. */
async function recordCompletionReceipt(
  jobId: string,
  receipt: Record<string, unknown>,
): Promise<void> {
  await db
    .update(transcodeJob)
    .set({ completionReceipt: receipt, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(transcodeJob.id, jobId))
    .catch((error) => {
      console.error('[TRANSCODER] could not record completion receipt:', error)
    })
}

/**
 * POST /jobs/:id/fail — the attempt failed.
 *
 * Uses the same finalizer as a Modal error callback, so the row and the
 * `video.failed` event are identical whichever provider produced them.
 */
app.post('/jobs/:id/fail', requireAgent, async (c) => {
  const agent = c.var.agent
  const jobId = c.req.param('id')
  const body = await readJson(c)
  const attemptId = typeof body?.attemptId === 'string' ? body.attemptId : null
  const message = typeof body?.message === 'string' ? body.message : 'Transcode failed'
  const failureCode = typeof body?.errorCode === 'string' ? body.errorCode : 'TRANSCODE_FAILED'

  if (!attemptId) return c.json({ error: 'attemptId is required' }, 400)

  const job = await loadJobForAgent(agent.id, jobId)
  if (!job) return c.json({ error: 'Job not found or not owned by this agent' }, 404)

  const outcome = await failJob(db, {
    jobId,
    attemptId,
    failureCode,
    message,
  })

  if (!outcome) {
    return c.json({ applied: false, reason: 'attempt-not-current' }, 409)
  }

  if (outcome.willRetry) {
    // A retryable failure leaves the video in `processing`: the next attempt
    // will pick it up, and telling the tenant "failed" in between would be a lie
    // the dashboard then has to walk back.
    return c.json({ applied: true, willRetry: true, attempts: outcome.attempts })
  }

  const videoRows = await db
    .select({ title: video.title, metadata: video.metadata, organizationId: video.organizationId })
    .from(video)
    .where(eq(video.id, job.videoId))
    .limit(1)
  const videoRecord = videoRows[0]
  if (!videoRecord) return c.json({ applied: false, reason: 'video-missing' }, 404)

  const failed = await finalizeVideoFailure(db, {
    videoId: job.videoId,
    organizationId: videoRecord.organizationId,
    title: videoRecord.title,
    attemptId,
    message,
    failureCode,
    prevMetadata: safeJson(videoRecord.metadata),
  })

  if (failed.applied) {
    c.executionCtx?.waitUntil?.(drainOutbox({ eventIds: [failed.eventId] }).catch(() => {}))
  }

  return c.json({
    applied: failed.applied,
    willRetry: false,
    attempts: outcome.attempts,
    eventId: failed.applied ? failed.eventId : null,
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

type OwnedJob = {
  jobId: string
  videoId: string
  organizationId: string
  sourceId: string | null
  options: Record<string, unknown>
  attemptId: string
  attempts: number
}

async function loadJobForAgent(agentId: string, jobId: string): Promise<OwnedJob | null> {
  const rows = await db
    .select({
      jobId: transcodeJob.id,
      videoId: transcodeJob.videoId,
      organizationId: transcodeJob.organizationId,
      sourceId: transcodeJob.sourceId,
      options: transcodeJob.options,
      attemptId: transcodeJob.attemptId,
      attempts: transcodeJob.attempts,
      state: transcodeJob.state,
    })
    .from(transcodeJob)
    .where(and(eq(transcodeJob.id, jobId), eq(transcodeJob.leaseOwner, agentId)))
    .limit(1)
  const job = rows[0]
  if (!job || !job.attemptId) return null
  if (![JOB_STATE_CLAIMED, JOB_STATE_RUNNING, JOB_STATE_PUBLISHING].includes(job.state as never)) {
    return null
  }
  return {
    jobId: job.jobId,
    videoId: job.videoId,
    organizationId: job.organizationId,
    sourceId: job.sourceId,
    options: (job.options ?? {}) as Record<string, unknown>,
    attemptId: job.attemptId,
    attempts: job.attempts,
  }
}

/**
 * Look up a job for *completion*, including terminal states.
 *
 * Different question from `loadJobForAgent`, which answers "may this agent act
 * on this job now". A completion replay arrives after the job succeeded and its
 * lease owner was cleared, so the liveness lookup answers 404 to the one call
 * that most needs an answer — turning a lost response into an agent that retries
 * forever.
 */
async function loadJobForCompletion(
  organizationId: string,
  jobId: string,
): Promise<{
  jobId: string
  videoId: string
  attemptId: string | null
  state: string
  completionReceipt: Record<string, unknown> | null
} | null> {
  const rows = await db
    .select({
      jobId: transcodeJob.id,
      videoId: transcodeJob.videoId,
      attemptId: transcodeJob.attemptId,
      state: transcodeJob.state,
      completionReceipt: transcodeJob.completionReceipt,
    })
    .from(transcodeJob)
    .where(
      and(
        eq(transcodeJob.id, jobId),
        eq(transcodeJob.organizationId, organizationId),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

async function requireOwnedJob(agentId: string, jobId: string): Promise<OwnedJob | null> {
  return loadJobForAgent(agentId, jobId)
}

type AuthorizedInventory = {
  inventoryId: string
  videoId: string
  attemptId: string
  prefix: string
  status: string
  playbackPolicy: string
}

/**
 * Resolve an inventory the calling agent may currently act on.
 *
 * Five conditions, and each closes a way the previous version was too loose:
 *
 *  1. the inventory belongs to a job this agent holds (`lease_owner`);
 *  2. the job has not been superseded by a newer attempt
 *     (`job.attempt_id = inventory.attempt_id`) — without this, an agent that
 *     received a *later* attempt for the same video was re-authorized against
 *     its *old* inventory and could keep uploading into the retired prefix;
 *  3. the job is still live and its lease has not expired;
 *  4. the video still names that attempt, which is the authority the completion
 *     path guards on;
 *  5. the video has not been deleted.
 *
 * A grant is a write capability. "The row exists" is not a reason to issue one.
 */
async function loadAuthorizedInventory(
  agentId: string,
  inventoryId: string,
): Promise<AuthorizedInventory | null> {
  const rows = await db
    .select({
      inventoryId: artifactInventory.id,
      videoId: artifactInventory.videoId,
      attemptId: artifactInventory.attemptId,
      prefix: artifactInventory.prefix,
      status: artifactInventory.status,
      playbackPolicy: video.playbackPolicy,
    })
    .from(artifactInventory)
    .innerJoin(video, eq(video.id, artifactInventory.videoId))
    .innerJoin(
      transcodeJob,
      and(
        eq(transcodeJob.id, artifactInventory.jobId),
        eq(transcodeJob.leaseOwner, agentId),
        eq(transcodeJob.attemptId, artifactInventory.attemptId),
        inArray(transcodeJob.state, [JOB_STATE_CLAIMED, JOB_STATE_RUNNING, JOB_STATE_PUBLISHING]),
        sql`${transcodeJob.leaseExpiresAt} > now()`,
      ),
    )
    .where(
      and(
        eq(artifactInventory.id, inventoryId),
        isNull(video.deletedAt),
        eq(video.transcodeAttemptId, artifactInventory.attemptId),
        sql`${artifactInventory.status} <> 'superseded'`,
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return {
    inventoryId: row.inventoryId,
    videoId: row.videoId,
    attemptId: row.attemptId,
    prefix: row.prefix,
    status: row.status,
    playbackPolicy: row.playbackPolicy ?? 'public',
  }
}

/**
 * Extend an attempt's lease on both rows.
 *
 * Returns whether it extended anything. Callers must refuse their operation when
 * it did not: a grant or an upload confirmation issued to an attempt whose lease
 * could not be renewed is exactly the "upload under ownership we no longer have"
 * case the lease exists to prevent. The video row is the authority for
 * completion, and the job row is the authority for publication, so both move.
 */
async function extendLease(
  videoId: string,
  attemptId: string,
  agentId: string,
): Promise<boolean> {
  const rows = normalizeRows(await db.execute(sql`
    WITH owning AS (
      SELECT 1 FROM transcode_job
      WHERE video_id = ${videoId}::uuid
        AND attempt_id = ${attemptId}
        AND lease_owner = ${agentId}
        AND state IN ('claimed', 'running', 'publishing')
    )
    UPDATE video
    SET transcode_lease_expires_at = now() + (${DEFAULT_JOB_LEASE_MS}::int * interval '1 millisecond'),
        last_heartbeat_at = now()
    WHERE id = ${videoId}::uuid
      AND transcode_attempt_id = ${attemptId}
      AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM owning)
    RETURNING id
  `))

  if (rows.length === 0) return false

  // The job lease is what the inventory authorization reads, so leaving it
  // behind would let it lapse while the video's stayed fresh.
  await db.execute(sql`
    UPDATE transcode_job
    SET lease_expires_at = now() + (${DEFAULT_JOB_LEASE_MS}::int * interval '1 millisecond'),
        updated_at = now()
    WHERE video_id = ${videoId}::uuid
      AND attempt_id = ${attemptId}
      AND lease_owner = ${agentId}
      AND state IN ('claimed', 'running', 'publishing')
  `)

  return true
}

async function claimNextForAgent(input: {
  agentId: string
  organizationId: string
  capacity: number
  organizationCapacity?: number | null
  leaseMs: number
}) {
  return claimNextJob(db, input)
}

async function claimPayload(claimed: {
  jobId: string
  videoId: string
  sourceId: string | null
  options: Record<string, unknown>
  attemptId: string
  attempts: number
}) {
  const sources = claimed.sourceId
    ? await db
        .select()
        .from(transcodeSource)
        .where(eq(transcodeSource.id, claimed.sourceId))
        .limit(1)
    : []

  const videos = await db
    .select({ playbackPolicy: video.playbackPolicy, title: video.title })
    .from(video)
    .where(eq(video.id, claimed.videoId))
    .limit(1)

  const source = sources[0]
  return {
    jobId: claimed.jobId,
    videoId: claimed.videoId,
    attemptId: claimed.attemptId,
    attempts: claimed.attempts,
    options: claimed.options,
    playbackPolicy: videos[0]?.playbackPolicy ?? 'public',
    title: videos[0]?.title ?? '',
    prefix: outputPrefixFor(claimed.videoId, claimed.attemptId),
    source: source
      ? {
          id: source.id,
          kind: source.kind,
          // Root name and root-relative path only. The absolute host path was
          // never stored, so it cannot leak here even by accident.
          rootName: source.rootName,
          relativePath: source.relativePath,
          fileName: source.fileName,
          sizeBytes: source.sizeBytes,
          identity: source.identity,
          contentSha256: source.contentSha256,
        }
      : null,
  }
}

async function jobVideoId(jobId: string): Promise<string | null> {
  const rows = await db
    .select({ videoId: transcodeJob.videoId })
    .from(transcodeJob)
    .where(eq(transcodeJob.id, jobId))
    .limit(1)
  return rows[0]?.videoId ?? null
}

function deliveryBaseUrl(env: Bindings | undefined): string {
  return (
    env?.DELIVERY_WORKER_URL ||
    env?.DELIVERY_URL ||
    process.env.DELIVERY_WORKER_URL ||
    process.env.DELIVERY_URL ||
    ''
  )
}

function transcodedBucketName(env: Bindings | undefined): string | null {
  return (
    env?.TRANSCODED_BUCKET_NAME ||
    process.env.TRANSCODED_BUCKET_NAME ||
    null
  )
}

function safeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Read a JSON body, tolerating a missing or malformed one.
 *
 * An agent that sends no body at all is normal for `/poll` and `/reconcile`; a
 * 400 there would make the client treat a benign call as a protocol error.
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

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}

const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  mpd: 'application/dash+xml',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  vtt: 'text/vtt',
  json: 'application/json',
}

export function contentTypeFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

export function cacheControlFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (extension === 'm3u8' || extension === 'mpd') return 'public, max-age=60'
  return 'public, max-age=31536000, immutable'
}

export default app
