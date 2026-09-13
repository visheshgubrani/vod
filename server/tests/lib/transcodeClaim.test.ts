import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  claimTranscodeAttempt,
  decideAttemptOwnership,
  classifyClaimFailure,
  type ClaimRejection,
} from '../../src/lib/transcodeClaim'
import { normalizeRows } from '../../src/lib/atomicWrite'
import { connectTestDb, createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'

// ────────────────────────────────────────────────────────────────────────────
// Rejection classification — pure, so it is checked with literals.
// ────────────────────────────────────────────────────────────────────────────
describe('classifyClaimFailure', () => {
  const base = { status: 'processing', deletedAt: null, actualAttemptId: 'att-A' }

  it('reports not-found when the row does not exist', () => {
    expect(classifyClaimFailure(null, { organizationCap: null })).toBe('not-found')
  })

  it('reports deleted ahead of every other reason', () => {
    const row = { ...base, deletedAt: new Date('2026-01-01T00:00:00Z') }
    expect(classifyClaimFailure(row, { organizationCap: null })).toBe('deleted')
  })

  it('reports at-capacity when the org already has enough live attempts', () => {
    expect(
      classifyClaimFailure(
        { ...base, status: 'uploading', organizationInFlight: 2 },
        { organizationCap: 2 },
      ),
    ).toBe('at-capacity')
  })

  it('reports already-claimed when nothing else explains the miss', () => {
    expect(
      classifyClaimFailure(
        { ...base, organizationInFlight: 0 },
        { organizationCap: null },
      ),
    ).toBe('already-claimed')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Claim semantics against a real database.
//
// Attempt ownership is the mechanism that stops a lost dispatch response from
// buying a second GPU execution, so these are the load-bearing tests.
// ────────────────────────────────────────────────────────────────────────────

const DDL = `
  DELETE FROM video WHERE organization_id LIKE 'org-claim-%';
  DELETE FROM organization WHERE id LIKE 'org-claim-%';
  INSERT INTO organization (id, name, slug, created_at)
  VALUES ('org-claim-a', 'Claim A', 'claim-a', now()),
         ('org-claim-b', 'Claim B', 'claim-b', now());
`

const VIDEO_DDL = (id: string, org: string, status: string) => `
  INSERT INTO video (id, organization_id, title, status)
  VALUES ('${id}', '${org}', '${id}', '${status}')
`

// video.id is a `uuid` column, so fixtures need real UUIDs. Named for
// readability — the values themselves are arbitrary.
const VIDEO_1 = '11111111-1111-4111-8111-111111111111'
const VIDEO_2 = '22222222-2222-4222-8222-222222222222'
const VIDEO_3 = '33333333-3333-4333-8333-333333333333'
const VIDEO_4 = '44444444-4444-4444-8444-444444444444'
const VIDEO_5 = '55555555-5555-4555-8555-555555555555'
const VIDEO_6 = '66666666-6666-4666-8666-666666666666'
const VIDEO_7 = '77777777-7777-4777-8777-777777777777'

const LEASE_FOREVER = 60 * 60_000

describe.skipIf(!hasTestDatabase)('claimTranscodeAttempt (real Postgres)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'openvod_t_claim' })
    await handle.exec(DDL)
  })

  afterAll(async () => {
    await handle?.close()
  })

  const newVideo = async (id: string, org: string, status = 'uploading') => {
    await handle.exec(VIDEO_DDL(id, org, status))
  }

  /** Simulate an attempt whose container died without releasing its lease. */
  const expireLease = async (id: string) => {
    await handle.exec(
      `UPDATE video SET transcode_lease_expires_at = now() - interval '1 hour'
       WHERE id = '${id}'`,
    )
  }

  const readVideo = async (id: string) => {
    const rows = normalizeRows(
      await handle.db.execute(
        sql`SELECT status, transcode_attempt_id, job_attempts, transcode_lease_expires_at
            FROM video WHERE id = ${id}`,
      ),
    )
    return rows[0]
  }

  it('claims an uploading row and takes ownership of it', async () => {
    await newVideo(VIDEO_1, 'org-claim-a')

    const result = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_1,
      attemptId: 'att-1',
      leaseMs: LEASE_FOREVER,
    })

    expect(result).toEqual({ claimed: true, attemptId: 'att-1', jobAttempts: 1 })
    const row = await readVideo(VIDEO_1)
    expect(row?.status).toBe('processing')
    expect(row?.transcode_attempt_id).toBe('att-1')
    expect(row?.job_attempts).toBe(1)
  })

  it('refuses a second claim while the first attempt is live and fresh', async () => {
    // Acceptance test 1: a lost dispatch response must not start a second run.
    const result = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_1,
      attemptId: 'att-2',
      leaseMs: LEASE_FOREVER,
    })

    expect(result).toEqual({ claimed: false, reason: 'already-claimed' })
    const row = await readVideo(VIDEO_1)
    // Ownership is unchanged: the first attempt still owns the row.
    expect(row?.transcode_attempt_id).toBe('att-1')
    expect(row?.job_attempts).toBe(1)
  })

  it('lets the sweeper reclaim once the holding lease has expired', async () => {
    await expireLease(VIDEO_1)

    const result = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_1,
      attemptId: 'att-3',
      leaseMs: LEASE_FOREVER,
      expectedAttemptId: 'att-1',
    })

    expect(result).toEqual({ claimed: true, attemptId: 'att-3', jobAttempts: 2 })
    expect((await readVideo(VIDEO_1))?.transcode_attempt_id).toBe('att-3')
  })

  it('refuses a reclaim that names the wrong (superseded) attempt id', async () => {
    // A stale sweeper that observed att-1 must not steal att-3's ownership,
    // even though the row is reclaimable on lease grounds.
    await expireLease(VIDEO_1)

    const result = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_1,
      attemptId: 'att-4',
      leaseMs: LEASE_FOREVER,
      expectedAttemptId: 'att-1',
    })

    expect(result).toEqual({ claimed: false, reason: 'already-claimed' })
    expect((await readVideo(VIDEO_1))?.transcode_attempt_id).toBe('att-3')
  })

  it('refuses an immediate reclaim while the fresh lease is still live', async () => {
    // Re-establish ownership with a live lease first: the previous test left
    // the row deliberately reclaimable on lease grounds.
    const established = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_1,
      attemptId: 'att-live',
      leaseMs: LEASE_FOREVER,
      expectedAttemptId: 'att-3',
    })
    expect(established).toEqual({ claimed: true, attemptId: 'att-live', jobAttempts: 3 })

    // Same observed attempt id, but the lease is live, so ownership stands.
    const again = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_1,
      attemptId: 'att-live-2',
      leaseMs: LEASE_FOREVER,
      expectedAttemptId: 'att-live',
    })

    expect(again).toEqual({ claimed: false, reason: 'already-claimed' })
    expect((await readVideo(VIDEO_1))?.transcode_attempt_id).toBe('att-live')
  })

  it('never claims a soft-deleted row', async () => {
    await newVideo(VIDEO_2, 'org-claim-a')
    // handle.exec is raw SQL — interpolate the literal rather than binding it.
    await handle.exec(`UPDATE video SET deleted_at = now() WHERE id = '${VIDEO_2}'`)

    const result = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_2,
      attemptId: 'att-deleted',
      leaseMs: LEASE_FOREVER,
    })

    expect(result).toEqual({ claimed: false, reason: 'deleted' })
  })

  it('enforces the per-organization concurrency cap', async () => {
    await newVideo(VIDEO_3, 'org-claim-b')
    await newVideo(VIDEO_4, 'org-claim-b')

    const first = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_3,
      attemptId: 'att-deleted',
      leaseMs: LEASE_FOREVER,
      organizationCap: 1,
    })
    expect(first.claimed).toBe(true)

    const second = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_4,
      attemptId: 'att-7',
      leaseMs: LEASE_FOREVER,
      organizationCap: 1,
    })
    expect(second).toEqual({ claimed: false, reason: 'at-capacity' })
  })

  it('releases capacity when the holding lease expires', async () => {
    // Expire the attempt that is holding org-claim-b's only slot.
    await expireLease(VIDEO_3)

    const result = await claimTranscodeAttempt(handle.db, {
      videoId: VIDEO_4,
      attemptId: 'att-8',
      leaseMs: LEASE_FOREVER,
      organizationCap: 1,
    })

    expect(result).toEqual({ claimed: true, attemptId: 'att-8', jobAttempts: 1 })
  })

  it('lets exactly one of two concurrent claims win', async () => {
    await newVideo(VIDEO_5, 'org-claim-a')
    // Racer needs its own connection: a single-connection handle serializes.
    const racer = await connectTestDb({ database: 'openvod_t_claim' })

    try {
      const results = await Promise.allSettled([
        claimTranscodeAttempt(handle.db, {
          videoId: VIDEO_5,
          attemptId: 'att-9',
          leaseMs: LEASE_FOREVER,
        }),
        claimTranscodeAttempt(racer.db, {
          videoId: VIDEO_5,
          attemptId: 'att-10',
          leaseMs: LEASE_FOREVER,
        }),
      ])

      const claimed = results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => (r as PromiseFulfilledResult<{ claimed: boolean }>).value)
        .filter((r) => r.claimed)

      expect(claimed).toHaveLength(1)
      expect((await readVideo(VIDEO_5))?.job_attempts).toBe(1)
    } finally {
      await racer.close()
    }
  })

  it('admits only one of two concurrent claims for DIFFERENT videos sharing one slot', async () => {
    // The guarantee the same-video race test cannot establish. Two claims for
    // different rows do not block each other under READ COMMITTED, so a bare
    // count(*) subquery lets both observe the same pre-state and both pass.
    // The organization lock is what serializes them.
    await handle.exec(`
      DELETE FROM video WHERE organization_id = 'org-claim-cap';
      DELETE FROM organization WHERE id = 'org-claim-cap';
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('org-claim-cap', 'Cap', 'claim-cap', now());
    `)
    await newVideo(VIDEO_6, 'org-claim-cap')
    await newVideo(VIDEO_7, 'org-claim-cap')

    const racer = await connectTestDb({ database: 'openvod_t_claim' })
    try {
      const [a, b] = await Promise.all([
        claimTranscodeAttempt(handle.db, {
          videoId: VIDEO_6,
          attemptId: 'att-cap-a',
          leaseMs: LEASE_FOREVER,
          organizationCap: 1,
        }),
        claimTranscodeAttempt(racer.db, {
          videoId: VIDEO_7,
          attemptId: 'att-cap-b',
          leaseMs: LEASE_FOREVER,
          organizationCap: 1,
        }),
      ])

      const winners = [a, b].filter((result) => result.claimed)
      expect(winners).toHaveLength(1)

      // The loser must not have been moved into processing at all.
      const loserId = a.claimed ? VIDEO_7 : VIDEO_6
      expect((await readVideo(loserId))?.status).toBe('uploading')
      expect((await readVideo(loserId))?.transcode_attempt_id).toBeNull()
    } finally {
      await racer.close()
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Attempt ownership guard for callbacks and heartbeats.
//
// This is the rule that stops a stalled attempt A from reporting success onto a
// row that attempt B now owns — the case a status-only guard cannot catch,
// because the row really is `processing` when A's callback arrives.
// ────────────────────────────────────────────────────────────────────────────
describe('decideAttemptOwnership', () => {
  it('accepts a callback that names the owning attempt', () => {
    expect(decideAttemptOwnership('att-B', 'att-B')).toEqual({ apply: true })
  })

  it('ignores a callback from a superseded attempt', () => {
    const decision = decideAttemptOwnership('att-B', 'att-A')
    expect(decision.apply).toBe(false)
    expect(decision.apply === false && decision.reason).toContain('superseded')
  })

  it('ignores a callback that does not identify its attempt', () => {
    // The row is owned, so an anonymous callback cannot be attributed.
    for (const missing of [undefined, null, '', 42]) {
      expect(decideAttemptOwnership('att-B', missing).apply).toBe(false)
    }
  })

  it('accepts an anonymous callback only when the row has no owner', () => {
    // Legacy in-flight job dispatched before attempt ownership existed.
    expect(decideAttemptOwnership(null, undefined)).toEqual({ apply: true })
    expect(decideAttemptOwnership(undefined, undefined)).toEqual({ apply: true })
  })
})
