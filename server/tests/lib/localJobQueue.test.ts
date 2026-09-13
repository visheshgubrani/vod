import { describe, expect, it } from 'vitest'
import {
  classifyWaitingReason,
  consumesRetry,
  nextAttemptDelayMs,
  prefixForAttempt,
  buildClaimNextJobStatement,
  buildFailJobStatement,
  buildCancelJobStatement,
  buildEnqueueStatement,
  buildReclaimExpiredJobsStatement,
} from '../../src/lib/localJobQueue'
import { containsClause, renderSql, sqlText } from '../helpers/sql'

describe('nextAttemptDelayMs', () => {
  it('backs off 30s, 2m, then 10m', () => {
    expect(nextAttemptDelayMs(1)).toBe(30_000)
    expect(nextAttemptDelayMs(2)).toBe(120_000)
    expect(nextAttemptDelayMs(3)).toBe(600_000)
    expect(nextAttemptDelayMs(9)).toBe(600_000)
  })

  it('caps jitter at 25%', () => {
    expect(nextAttemptDelayMs(1, { jitter: 1 })).toBe(37_500)
    expect(nextAttemptDelayMs(1, { jitter: 5 })).toBe(37_500)
    expect(nextAttemptDelayMs(1, { jitter: -1 })).toBe(30_000)
  })

  it('does not escalate the backoff while waiting on a source', () => {
    // A laptop that is shut for the weekend has not failed three times.
    expect(nextAttemptDelayMs(9, { sourceWait: true })).toBe(60_000)
  })
})

describe('consumesRetry', () => {
  it('consumes a retry for an ordinary failure', () => {
    expect(consumesRetry('ENCODER_FAILED')).toBe(true)
    expect(consumesRetry(null)).toBe(true)
  })

  it('never consumes a retry for a source that is missing or changed', () => {
    // The file may be on a drive that is not mounted yet; giving up would lose
    // the owner's import.
    expect(consumesRetry('SOURCE_MISSING')).toBe(false)
    expect(consumesRetry('SOURCE_CHANGED')).toBe(false)
  })
})

describe('prefixForAttempt', () => {
  it('is attempt-scoped so a late worker cannot overwrite a newer attempt', () => {
    expect(prefixForAttempt('vid-1', 'att-2')).toBe('videos/vid-1/attempts/att-2')
  })
})

describe('classifyWaitingReason', () => {
  const base = {
    jobAgentId: 'agt_1',
    onlineAgentIds: new Set(['agt_1']),
    sourceKind: 'local',
    sourceAvailability: 'available',
    agentCapacityFree: true,
    nextAttemptAt: null,
    now: new Date('2026-03-01T12:00:00Z'),
  }

  it('is null when nothing is waiting', () => {
    expect(classifyWaitingReason(base)).toBeNull()
  })

  it('reports an offline bound agent', () => {
    expect(classifyWaitingReason({ ...base, onlineAgentIds: new Set() })).toBe('agent-offline')
  })

  it('reports a busy agent separately from an offline one', () => {
    expect(classifyWaitingReason({ ...base, agentCapacityFree: false })).toBe('agent-busy')
  })

  it('reports a missing source ahead of agent state', () => {
    expect(
      classifyWaitingReason({
        ...base,
        sourceAvailability: 'missing',
        onlineAgentIds: new Set(),
      }),
    ).toBe('source-missing')
  })

  it('reports a changed source', () => {
    expect(classifyWaitingReason({ ...base, sourceAvailability: 'changed' })).toBe(
      'source-changed',
    )
  })

  it('reports that no agent can ever satisfy an unbound local source', () => {
    expect(classifyWaitingReason({ ...base, jobAgentId: null })).toBe('no-eligible-agent')
  })

  it('reports retry backoff while the next attempt is in the future', () => {
    expect(
      classifyWaitingReason({
        ...base,
        nextAttemptAt: new Date('2026-03-01T12:05:00Z'),
      }),
    ).toBe('retry-backoff')
  })

  it('lets an r2 source run on any online agent', () => {
    expect(
      classifyWaitingReason({
        ...base,
        sourceKind: 'r2',
        jobAgentId: null,
        onlineAgentIds: new Set(['agt_9']),
      }),
    ).toBeNull()
  })

  it('reports agent-offline for an r2 source when no agent is online', () => {
    expect(
      classifyWaitingReason({
        ...base,
        sourceKind: 'r2',
        jobAgentId: null,
        onlineAgentIds: new Set(),
      }),
    ).toBe('agent-offline')
  })
})

describe('enqueue statement', () => {
  const statement = buildEnqueueStatement({
    videoId: 'vid-1',
    organizationId: 'org-1',
    sourceId: 'src-1',
    agentId: 'agt_1',
    options: { maxHeight: 720 },
  })

  it('moves the video to processing without claiming an attempt', () => {
    // Queued work must not consume an attempt or a concurrency slot.
    const text = sqlText(statement)
    expect(text).toContain("status = 'processing'")
    expect(text).not.toContain('transcode_attempt_id')
    expect(text).not.toContain('transcode_lease_expires_at')
  })

  it('refuses to queue work for a deleted video', () => {
    expect(sqlText(statement)).toContain('deleted_at IS NULL')
  })

  it('writes the options blob as a bound parameter, not interpolated JSON', () => {
    const { params } = renderSql(statement)
    expect(params).toContain(JSON.stringify({ maxHeight: 720 }))
  })

  it('does not emit an event for queuing', () => {
    // Queuing is not a lifecycle transition consumers were promised.
    expect(sqlText(statement)).not.toContain('event_outbox')
  })
})

describe('claim-next statement', () => {
  const statement = buildClaimNextJobStatement({
    agentId: 'agt_1',
    organizationId: 'org-1',
    agentCapacity: 1,
  })

  it('locks the job row explicitly, not the nullable side of its outer join', () => {
    // PostgreSQL rejects an unqualified `FOR UPDATE` here with "FOR UPDATE
    // cannot be applied to the nullable side of an outer join", so the statement
    // never ran at all. This assertion is a *shape* claim; the behaviour is
    // covered by localJobQueue.db.test.ts, which executes it.
    expect(containsClause(statement, 'FOR UPDATE OF j SKIP LOCKED')).toBe(true)
    expect(containsClause(statement, 'LEFT JOIN transcode_source')).toBe(true)
  })

  it('binds the claim to the calling agent’s organization', () => {
    expect(containsClause(statement, 'j.organization_id =')).toBe(true)
  })

  it('counts capacity by live ownership rather than by source affinity', () => {
    // `agent_id` is NULL for r2 jobs by design, so counting it under-admits.
    expect(containsClause(statement, 'active.lease_owner =')).toBe(true)
    expect(containsClause(statement, 'active.organization_id = j.organization_id')).toBe(true)
    expect(containsClause(statement, "active.state IN ('claimed', 'running', 'publishing')")).toBe(
      true,
    )
  })

  it('pins a local source to the agent that holds the file', () => {
    expect(
      containsClause(statement, "s.kind <> 'local' OR s.agent_id ="),
    ).toBe(true)
  })

  it('refuses to dispatch a source that is not available', () => {
    expect(containsClause(statement, "s.availability = 'available'")).toBe(true)
  })

  it('bounds this agent by its own active job count', () => {
    expect(containsClause(statement, 'active.lease_expires_at > now()')).toBe(true)
  })

  it('only claims a video that can legally transition', () => {
    expect(
      containsClause(statement, "status IN ('processing', 'uploading', 'failed', 'pending')"),
    ).toBe(true)
  })

  it('mints the attempt id and lease in the same statement as the claim', () => {
    const text = sqlText(statement)
    expect(text).toContain('transcode_attempt_id =')
    expect(text).toContain('transcode_lease_expires_at = now() +')
  })
})

describe('fail statement', () => {
  const statement = buildFailJobStatement({
    jobId: 'job-1',
    attemptId: 'att-1',
    failureCode: 'ENCODER_FAILED',
    message: 'gpu died',
  })

  it('decides retry-versus-terminal from the row it writes', () => {
    expect(containsClause(statement, 'attempts < max_attempts')).toBe(true)
  })

  it('releases the attempt so a retry can mint a new one', () => {
    expect(containsClause(statement, 'attempt_id = NULL')).toBe(true)
    expect(containsClause(statement, 'lease_expires_at = NULL')).toBe(true)
  })

  it('only fails the attempt that still owns the job', () => {
    expect(containsClause(statement, 'attempt_id =')).toBe(true)
  })

  it('counts a source wait rather than an attempt', () => {
    expect(containsClause(statement, 'source_wait_count')).toBe(true)
  })
})

describe('cancel statement', () => {
  const statement = buildCancelJobStatement({ jobId: 'job-1', organizationId: 'org-1' })

  it('scopes the cancel to the owning organization', () => {
    expect(containsClause(statement, 'organization_id =')).toBe(true)
  })

  it('releases the video attempt id so a late completion cannot publish', () => {
    expect(containsClause(statement, 'transcode_attempt_id = NULL')).toBe(true)
  })

  it('refuses to resurrect a terminal job', () => {
    expect(
      containsClause(statement, "state IN ('queued', 'claimed', 'running', 'publishing', 'failed')"),
    ).toBe(true)
  })
})

describe('expired-lease reclaim', () => {
  const statement = buildReclaimExpiredJobsStatement({ limit: 5 })

  it('only reclaims a genuinely expired lease', () => {
    expect(containsClause(statement, 'lease_expires_at < now()')).toBe(true)
  })

  it('releases the video attempt id in the same statement', () => {
    expect(containsClause(statement, 'transcode_attempt_id = NULL')).toBe(true)
  })

  it('returns work to the queue with an explicit waiting reason', () => {
    expect(containsClause(statement, "waiting_reason = 'agent-offline'")).toBe(true)
  })
})
