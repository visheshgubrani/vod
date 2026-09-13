/**
 * Queue behaviour against a real PostgreSQL.
 *
 * The previous version of this file asserted that guards *appeared* in the
 * rendered SQL. That cannot establish anything that matters: every P1 in the
 * review was a statement that either PostgreSQL refused outright
 * (`FOR UPDATE` on a nullable outer join, nested `VALUES`) or that ran and did
 * the wrong thing because a data-modifying CTE's changes are invisible to the
 * rest of its own statement. Substring assertions passed through all of them.
 *
 * So these run the actual statements and assert what the tables contain
 * afterwards. `tests/helpers/db.ts` gives each suite its own migrated database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  buildClaimJobStatement,
  buildClaimNextJobStatement,
  buildFailJobStatement,
  buildRequeueStatement,
  claimJob,
  claimNextJob,
  failJob,
  reclaimExpiredJobs,
} from '../../src/lib/localJobQueue'
import { transcodeJob, video } from '../../src/db/schema'
import { connectTestDb, createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'

const ORG_A = 'org-queue-a'
const ORG_B = 'org-queue-b'
const VID_A = '11111111-1111-1111-1111-111111111111'
const VID_B = '22222222-2222-2222-2222-222222222222'
const VID_C = '33333333-3333-3333-3333-333333333333'
const JOB_A = 'aaaaaaaa-0000-0000-0000-00000000000a'
const JOB_B = 'bbbbbbbb-0000-0000-0000-00000000000b'
const SRC_R2 = 'cccccccc-0000-0000-0000-00000000000c'

describe.skipIf(!hasTestDatabase)('localJobQueue (PostgreSQL)', () => {
  let handle: TestDbHandle
  let other: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'queue_suite', max: 4 })
    // A second connection for the concurrency tests: an independent session is
    // the only way to observe that two claims actually serialize.
    other = await connectTestDb({ database: 'queue_suite', max: 4 })
    await seed(handle)
  })

  afterAll(async () => {
    await other?.close()
    await handle?.close()
  })

  async function seed(h: TestDbHandle) {
    await h.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG_A}', 'Queue A', 'queue-a', now()), ('${ORG_B}', 'Queue B', 'queue-b', now())
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO transcoder_agent (id, organization_id, name, token_hash, token_last4, capacity_jobs)
      VALUES
        ('agent-a', '${ORG_A}', 'Agent A', 'hash-a', 'aaaa', 1),
        ('agent-b', '${ORG_B}', 'Agent B', 'hash-b', 'bbbb', 1)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO video (id, organization_id, title, status)
      VALUES
        ('${VID_A}', '${ORG_A}', 'A', 'processing'),
        ('${VID_B}', '${ORG_A}', 'B', 'processing'),
        ('${VID_C}', '${ORG_B}', 'C', 'processing')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO transcode_source (id, organization_id, kind, agent_id)
      VALUES ('${SRC_R2}', '${ORG_A}', 'r2', NULL)
      ON CONFLICT (id) DO NOTHING;
    `)
  }

  async function resetJobs() {
    await handle.exec(`
      DELETE FROM transcode_job;
      UPDATE video SET status='processing', transcode_attempt_id=NULL,
        transcode_lease_expires_at=NULL, job_attempts=0, failure_code=NULL;
    `)
  }

  async function queueJob(id: string, videoId: string, organizationId: string, sourceId: string | null) {
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, source_id, agent_id, state)
      VALUES ('${id}', '${videoId}', '${organizationId}', 'self-hosted', ${sourceId ? `'${sourceId}'` : 'NULL'}, NULL, 'queued');
    `)
  }

  // ── finding 2 and 3 ──────────────────────────────────────────────────────

  it('executes the automatic claim and records the minted attempt on both rows', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)

    const claimed = await claimNextJob(handle.db, {
      agentId: 'agent-a',
      organizationId: ORG_A,
      capacity: 1,
    })

    expect(claimed).not.toBeNull()
    expect(claimed!.attemptId).toBeTruthy()

    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    const [vid] = await handle.db.select().from(video).where(eq(video.id, VID_A))

    expect(job.state).toBe('claimed')
    expect(job.attemptId).toBe(claimed!.attemptId)
    // The job's attempt must match the video's, not the pre-update NULL the
    // sibling CTE left behind in the statement's snapshot.
    expect(job.attemptId).toBe(vid.transcodeAttemptId)
    expect(job.leaseOwner).toBe('agent-a')
    expect(vid.jobAttempts).toBe(1)
  })

  // ── finding 1 ────────────────────────────────────────────────────────────

  it('refuses a named claim from another organization', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)

    const refused = await claimJob(handle.db, {
      jobId: JOB_A,
      agentId: 'agent-b',
      organizationId: ORG_B,
      attemptId: 'att-cross-org',
      agentCapacity: 1,
    })

    expect(refused).toBeNull()
    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    const [vid] = await handle.db.select().from(video).where(eq(video.id, VID_A))
    expect(job.state).toBe('queued')
    expect(job.attemptId).toBeNull()
    expect(job.leaseOwner).toBeNull()
    expect(vid.transcodeAttemptId).toBeNull()
  })

  it('allows a named claim from the owning organization', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)

    const claimed = await claimJob(handle.db, {
      jobId: JOB_A,
      agentId: 'agent-a',
      organizationId: ORG_A,
      attemptId: 'att-owned',
      agentCapacity: 1,
    })

    expect(claimed?.attemptId).toBe('att-owned')
  })

  // ── finding 12 ───────────────────────────────────────────────────────────

  it('counts capacity by live ownership, including r2 jobs with no bound agent', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)
    await queueJob(JOB_B, VID_B, ORG_A, SRC_R2)

    // First job: an r2 source, so `agent_id` stays NULL.
    const first = await claimNextJob(handle.db, {
      agentId: 'agent-a',
      organizationId: ORG_A,
      capacity: 1,
    })
    expect(first).not.toBeNull()

    const [row] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    expect(row.agentId).toBeNull()
    expect(row.leaseOwner).toBe('agent-a')

    // A capacity check keyed on `agent_id` would see zero active jobs here and
    // hand out a second one.
    const second = await claimNextJob(handle.db, {
      agentId: 'agent-a',
      organizationId: ORG_A,
      capacity: 1,
    })
    expect(second).toBeNull()
  })

  it('serializes concurrent claims so one agent cap holds', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)
    await queueJob(JOB_B, VID_B, ORG_A, SRC_R2)

    // Two independent connections claiming simultaneously. A per-job
    // `SKIP LOCKED` alone cannot stop both: they lock different job rows, so
    // nothing serializes the capacity subquery.
    const [left, right] = await Promise.all([
      claimNextJob(handle.db, { agentId: 'agent-a', organizationId: ORG_A, capacity: 1 }),
      claimNextJob(other.db, { agentId: 'agent-a', organizationId: ORG_A, capacity: 1 }),
    ])

    const winners = [left, right].filter(Boolean)
    expect(winners).toHaveLength(1)
  })

  it('serializes concurrent claims across organizations independently', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)
    await queueJob('dddddddd-0000-0000-0000-00000000000d', VID_C, ORG_B, null)

    const [a, b] = await Promise.all([
      claimNextJob(handle.db, { agentId: 'agent-a', organizationId: ORG_A, capacity: 1 }),
      claimNextJob(other.db, { agentId: 'agent-b', organizationId: ORG_B, capacity: 1 }),
    ])

    expect(a?.videoId).toBe(VID_A)
    expect(b?.videoId).toBe(VID_C)
  })

  it('never claims across organizations', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)

    const claimed = await claimNextJob(handle.db, {
      agentId: 'agent-b',
      organizationId: ORG_B,
      capacity: 1,
    })
    expect(claimed).toBeNull()
  })

  it('refuses to claim a source that is not available', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)
    await handle.exec(`UPDATE transcode_source SET availability='missing' WHERE id='${SRC_R2}'`)

    const claimed = await claimNextJob(handle.db, {
      agentId: 'agent-a',
      organizationId: ORG_A,
      capacity: 1,
    })
    expect(claimed).toBeNull()

    await handle.exec(`UPDATE transcode_source SET availability='available' WHERE id='${SRC_R2}'`)
  })

  it('refuses to claim a deleted video', async () => {
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)
    await handle.exec(`UPDATE video SET deleted_at = now() WHERE id='${VID_A}'`)

    const claimed = await claimNextJob(handle.db, {
      agentId: 'agent-a',
      organizationId: ORG_A,
      capacity: 1,
    })
    expect(claimed).toBeNull()

    await handle.exec(`UPDATE video SET deleted_at = NULL WHERE id='${VID_A}'`)
  })

  // ── finding 15 ───────────────────────────────────────────────────────────

  async function claimForFailure(jobId: string, videoId: string, attemptId: string, attempts = 1) {
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner, attempts)
      VALUES ('${jobId}', '${videoId}', '${ORG_A}', 'self-hosted', 'claimed', '${attemptId}', 'agent-a', ${attempts})
      ON CONFLICT (id) DO UPDATE SET state='claimed', attempt_id='${attemptId}',
        lease_owner='agent-a', attempts=${attempts}, waiting_reason=NULL, finished_at=NULL;
      UPDATE video SET transcode_attempt_id='${attemptId}' WHERE id='${videoId}';
    `)
  }

  it('returns a missing source to the queue with a waiting reason', async () => {
    await resetJobs()
    await claimForFailure(JOB_A, VID_A, 'att-missing')

    const outcome = await failJob(handle.db, {
      jobId: JOB_A,
      attemptId: 'att-missing',
      failureCode: 'SOURCE_MISSING',
      message: 'file is gone',
    })

    expect(outcome?.willRetry).toBe(true)
    expect(outcome?.waitingReason).toBe('source-missing')
    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    expect(job.state).toBe('queued')
    expect(job.waitingReason).toBe('source-missing')
    expect(job.sourceWaitCount).toBe(1)
  })

  it('does not spend the attempt budget while waiting for a source', async () => {
    await resetJobs()
    await claimForFailure(JOB_A, VID_A, 'att-wait', 3)

    await failJob(handle.db, {
      jobId: JOB_A,
      attemptId: 'att-wait',
      failureCode: 'SOURCE_CHANGED',
      message: 'file changed',
    })

    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    // Three claims had already been made; waiting gives one back.
    expect(job.attempts).toBe(2)
    expect(job.state).toBe('queued')
  })

  it('still fails eventually on a source that never comes back, once cancelled', async () => {
    await resetJobs()
    await claimForFailure(JOB_A, VID_A, 'att-cancel')
    const { cancelJob } = await import('../../src/lib/localJobQueue')
    const cancelled = await cancelJob(handle.db, {
      jobId: JOB_A,
      organizationId: ORG_A,
      reason: 'operator',
    })
    expect(cancelled).not.toBeNull()
    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    expect(job.state).toBe('cancelled')
  })

  it('gives up on a retryable failure once the budget is spent', async () => {
    await resetJobs()
    await claimForFailure(JOB_A, VID_A, 'att-fail', 3)

    const outcome = await failJob(handle.db, {
      jobId: JOB_A,
      attemptId: 'att-fail',
      failureCode: 'ENCODER_FAILED',
      message: 'gpu died',
    })

    expect(outcome?.willRetry).toBe(false)
    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    expect(job.state).toBe('failed')
    expect(job.finishedAt).not.toBeNull()
  })

  it('retries a retryable failure while budget remains', async () => {
    await resetJobs()
    await claimForFailure(JOB_A, VID_A, 'att-retry', 1)

    const outcome = await failJob(handle.db, {
      jobId: JOB_A,
      attemptId: 'att-retry',
      failureCode: 'ENCODER_FAILED',
      message: 'gpu died',
    })

    expect(outcome?.willRetry).toBe(true)
    expect(outcome?.waitingReason).toBe('retry-backoff')
  })

  it('fails immediately on a terminal media failure', async () => {
    await resetJobs()
    await claimForFailure(JOB_A, VID_A, 'att-bad', 1)

    const outcome = await failJob(handle.db, {
      jobId: JOB_A,
      attemptId: 'att-bad',
      failureCode: 'INVALID_CONTAINER',
      message: 'not media',
    })

    expect(outcome?.willRetry).toBe(false)
  })

  it('ignores a failure from an attempt that no longer owns the job', async () => {
    await resetJobs()
    await claimForFailure(JOB_A, VID_A, 'att-current')

    const outcome = await failJob(handle.db, {
      jobId: JOB_A,
      attemptId: 'att-superseded',
      failureCode: 'ENCODER_FAILED',
      message: 'late',
    })

    expect(outcome).toBeNull()
    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    expect(job.state).toBe('claimed')
  })

  // ── lease reclaim ────────────────────────────────────────────────────────

  it('reclaims an expired lease and releases the video attempt', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner, lease_expires_at)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'running', 'att-stale', 'agent-a', now() - interval '5 minutes');
      UPDATE video SET transcode_attempt_id='att-stale', transcode_lease_expires_at = now() - interval '5 minutes' WHERE id='${VID_A}';
    `)

    const reclaimed = await reclaimExpiredJobs(handle.db, { limit: 10 })
    expect(reclaimed.map((entry) => entry.jobId)).toContain(JOB_A)

    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    expect(job.state).toBe('queued')
    expect(job.attemptId).toBeNull()
    expect(job.waitingReason).toBe('agent-offline')

    const [vid] = await handle.db.select().from(video).where(eq(video.id, VID_A))
    expect(vid.transcodeAttemptId).toBeNull()
  })

  it('leaves a live lease alone', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner, lease_expires_at)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'running', 'att-live', 'agent-a', now() + interval '5 minutes');
    `)

    const reclaimed = await reclaimExpiredJobs(handle.db, { limit: 10 })
    expect(reclaimed.map((entry) => entry.jobId)).not.toContain(JOB_A)
  })

  // ── statement construction guards ────────────────────────────────────────

  it('claims nothing when the organization does not match any job', async () => {
    // The organization is a required field on the input type, so a caller cannot
    // omit it; this asserts the *behaviour* of a wrong value, which is what the
    // type system cannot promise. An empty string must match no row rather than
    // act as a wildcard.
    await resetJobs()
    await queueJob(JOB_A, VID_A, ORG_A, SRC_R2)

    const claimed = await claimJob(handle.db, {
      jobId: JOB_A,
      agentId: 'agent-a',
      organizationId: '',
      attemptId: 'att-blank-org',
      agentCapacity: 1,
    })
    expect(claimed).toBeNull()

    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    expect(job.state).toBe('queued')
    expect(buildClaimJobStatement).toBeTypeOf('function')
  })

  // ── finding 11: a restarted agent can finish what it already owns ───────

  it('resumes an attempt the agent still owns, renewing both leases', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner, lease_expires_at)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'running', 'att-resume', 'agent-a', now() + interval '1 minute');
      UPDATE video SET transcode_attempt_id='att-resume', transcode_lease_expires_at = now() + interval '1 minute'
      WHERE id='${VID_A}';
    `)

    const { resumeOwnedAttempt } = await import('../../src/lib/localJobQueue')
    const resumed = await resumeOwnedAttempt(handle.db, {
      jobId: JOB_A,
      attemptId: 'att-resume',
      agentId: 'agent-a',
    })

    expect(resumed).not.toBeNull()
    expect(resumed?.attemptId).toBe('att-resume')
    expect(resumed?.videoId).toBe(VID_A)

    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    const [vid] = await handle.db.select().from(video).where(eq(video.id, VID_A))
    // Both leases move: the inventory authorization reads the job's, the
    // completion path reads the video's, and renewing one alone leaves the other
    // to expire mid-resume.
    expect(job.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000)
    expect(vid.transcodeLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000)
  })

  it('refuses to resume an attempt the agent does not own', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'running', 'att-other-agent', 'agent-b');
      UPDATE video SET transcode_attempt_id='att-other-agent' WHERE id='${VID_A}';
    `)

    const { resumeOwnedAttempt } = await import('../../src/lib/localJobQueue')
    expect(
      await resumeOwnedAttempt(handle.db, {
        jobId: JOB_A,
        attemptId: 'att-other-agent',
        agentId: 'agent-a',
      }),
    ).toBeNull()
  })

  it('refuses to resume once the video has moved to a newer attempt', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'running', 'att-old', 'agent-a');
      UPDATE video SET transcode_attempt_id='att-newer' WHERE id='${VID_A}';
    `)

    const { resumeOwnedAttempt } = await import('../../src/lib/localJobQueue')
    expect(
      await resumeOwnedAttempt(handle.db, {
        jobId: JOB_A,
        attemptId: 'att-old',
        agentId: 'agent-a',
      }),
    ).toBeNull()
  })

  it('refuses to resume a job in a terminal state', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'succeeded', 'att-done', NULL);
      UPDATE video SET transcode_attempt_id=NULL WHERE id='${VID_A}';
    `)

    const { resumeOwnedAttempt } = await import('../../src/lib/localJobQueue')
    expect(
      await resumeOwnedAttempt(handle.db, {
        jobId: JOB_A,
        attemptId: 'att-done',
        agentId: 'agent-a',
      }),
    ).toBeNull()
  })

  // ── finding 14: retry keeps the provider the job was created with ───────

  it('re-opens a failed job and its video in one statement', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, failure_code, attempts, finished_at)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'failed', NULL, 'ENCODER_FAILED', 3, now());
      UPDATE video SET status='failed', failure_code='ENCODER_FAILED' WHERE id='${VID_A}';
    `)

    const { requeueJob } = await import('../../src/lib/localJobQueue')
    const requeued = await requeueJob(handle.db, {
      jobId: JOB_A,
      videoId: VID_A,
      organizationId: ORG_A,
    })

    expect(requeued).not.toBeNull()
    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    const [vid] = await handle.db.select().from(video).where(eq(video.id, VID_A))

    // Both rows move together: a job requeued while its video stayed `failed`
    // would be claimed and immediately refused by the video's state guard.
    expect(job.state).toBe('queued')
    expect(job.attempts).toBe(0)
    expect(job.failureCode).toBeNull()
    expect(vid.status).toBe('processing')
    expect(vid.failureCode).toBeNull()
  })

  it('preserves the stored provider across a retry', async () => {
    // The provider is stored so a later default change cannot reroute existing
    // work. Retrying through the Modal path unconditionally sent self-hosted
    // jobs to Modal, and rejected local imports for having no rawKey.
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'failed');
      UPDATE video SET status='failed' WHERE id='${VID_A}';
    `)

    const { requeueJob } = await import('../../src/lib/localJobQueue')
    await requeueJob(handle.db, { jobId: JOB_A, videoId: VID_A, organizationId: ORG_A })

    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB_A))
    expect(job.provider).toBe('self-hosted')
  })

  it('refuses to re-open a job that is still running', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'running', 'att-live', 'agent-a');
    `)
    const { requeueJob } = await import('../../src/lib/localJobQueue')
    const requeued = await requeueJob(handle.db, {
      jobId: JOB_A,
      videoId: VID_A,
      organizationId: ORG_A,
    })
    expect(requeued).toBeNull()
  })

  it('refuses to re-open a job from another organization', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'failed');
    `)
    const { requeueJob } = await import('../../src/lib/localJobQueue')
    const requeued = await requeueJob(handle.db, {
      jobId: JOB_A,
      videoId: VID_A,
      organizationId: ORG_B,
    })
    expect(requeued).toBeNull()
  })

  it('retires the failed attempt’s inventory when re-opening', async () => {
    await resetJobs()
    await handle.exec(`
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state)
      VALUES ('${JOB_A}', '${VID_A}', '${ORG_A}', 'self-hosted', 'failed');
      INSERT INTO artifact_inventory (video_id, organization_id, job_id, attempt_id, prefix, status, item_count)
      VALUES ('${VID_A}', '${ORG_A}', '${JOB_A}', 'att-dead', 'videos/${VID_A}/attempts/att-dead', 'verified', 1);
      UPDATE video SET status='failed' WHERE id='${VID_A}';
    `)

    const { requeueJob } = await import('../../src/lib/localJobQueue')
    await requeueJob(handle.db, { jobId: JOB_A, videoId: VID_A, organizationId: ORG_A })

    const rows = await handle.exec(
      `SELECT status FROM artifact_inventory WHERE attempt_id='att-dead'`,
    )
    // A retried job must not leave the dead attempt's grants renewable.
    expect((rows as unknown as Array<{ status: string }>)[0]?.status).toBe('superseded')
  })
})
