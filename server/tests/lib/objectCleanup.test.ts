import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  claimCleanupJobs,
  decideCleanupOutcome,
  DEFAULT_CLEANUP_LIMITS,
  runObjectCleanup,
  type CleanupDeps,
} from '../../src/lib/objectCleanup'
import { normalizeRows } from '../../src/lib/atomicWrite'
import type { ObjectStore } from '../../src/utils/objectStore'
import { createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'

/**
 * Storage cleanup reconciliation.
 *
 * The pure outcome rule is checked with literals. Everything else runs against
 * real Postgres, because the properties that matter — lease ownership, the
 * writer-retirement gate, and "reclaimed only when a fresh listing is empty" —
 * live in the storage layer.
 */

describe('decideCleanupOutcome', () => {
  it('reclaims only when a fresh listing is empty', () => {
    expect(decideCleanupOutcome({ remaining: 0, attemptsMade: 1 })).toEqual({
      kind: 'reclaim',
    })
  })

  it('retries while objects remain and budget is left', () => {
    const outcome = decideCleanupOutcome({ remaining: 3, attemptsMade: 1 })
    expect(outcome).toEqual({ kind: 'retry', delayMs: 120_000 })
  })

  it('backs off exponentially, capped', () => {
    expect(decideCleanupOutcome({ remaining: 1, attemptsMade: 0 })).toEqual({
      kind: 'retry',
      delayMs: 60_000,
    })
    expect(decideCleanupOutcome({ remaining: 1, attemptsMade: 3 })).toEqual({
      kind: 'retry',
      delayMs: 480_000,
    })
    // 60s * 2^7 = 7680s, clamped to the one-hour ceiling (and still within the
    // 8-attempt budget, so it is a retry rather than a give-up).
    expect(decideCleanupOutcome({ remaining: 1, attemptsMade: 7 })).toEqual({
      kind: 'retry',
      delayMs: 3_600_000,
    })
  })

  it('fails once the attempt budget is spent, naming what is left', () => {
    const outcome = decideCleanupOutcome({
      remaining: 4,
      attemptsMade: DEFAULT_CLEANUP_LIMITS.maxAttempts,
    })
    expect(outcome.kind).toBe('fail')
    expect(outcome.kind === 'fail' && outcome.reason).toContain('4 object(s)')
  })

  it('never reclaims on an error, even with no attempts left', () => {
    // A thrown bucket error is passed in as "not proven empty".
    const outcome = decideCleanupOutcome({
      remaining: Number.POSITIVE_INFINITY,
      attemptsMade: 0,
      lastError: 'AccessDenied',
    })
    expect(outcome.kind).toBe('retry')
  })
})

/** In-memory bucket that can be mutated mid-test to simulate a late writer. */
function fakeStore(initial: Record<string, string[]>) {
  const buckets: Record<string, Set<string>> = {}
  for (const [bucket, keys] of Object.entries(initial)) {
    buckets[bucket] = new Set(keys)
  }
  const aborted: string[] = []

  const store: ObjectStore = {
    async listKeys(bucket, prefix) {
      return [...(buckets[bucket] ?? [])].filter((key) => key.startsWith(prefix)).sort()
    },
    async deleteKeys(bucket, keys) {
      let n = 0
      for (const key of keys) {
        if (buckets[bucket]?.delete(key)) n += 1
      }
      return n
    },
    async abortMultipartUploads(bucket, prefix) {
      aborted.push(`${bucket}:${prefix}`)
      return 0
    },
  }

  return {
    store,
    aborted,
    put(bucket: string, key: string) {
      buckets[bucket] = buckets[bucket] ?? new Set()
      buckets[bucket].add(key)
    },
  }
}

const VIDEO_1 = 'dddddddd-1111-4111-8111-dddddddddddd'
const VIDEO_2 = 'dddddddd-2222-4222-8222-dddddddddddd'
const ORG = 'org-cleanup'
const RAW_BUCKET = 'raw-bucket'
const TRANSCODED_BUCKET = 'transcoded-bucket'

describe.skipIf(!hasTestDatabase)('runObjectCleanup (real Postgres)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = createTestDb()
    await handle.exec(`
      DELETE FROM storage_cleanup_job;
      DELETE FROM video WHERE organization_id = '${ORG}';
      DELETE FROM organization WHERE id = '${ORG}';
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG}', 'Cleanup', 'cleanup-org', now());
    `)
  })

  afterAll(async () => {
    await handle?.close()
  })

  const seedJob = async (
    videoId: string,
    rawKey: string | null,
    opts: { notBefore?: string; status?: string } = {},
  ) => {
    await handle.exec(`
      DELETE FROM storage_cleanup_job WHERE video_id = '${videoId}';
      INSERT INTO storage_cleanup_job (id, video_id, organization_id, raw_key, prefix, status, not_before)
      VALUES ('scj_${videoId}', '${videoId}', '${ORG}', ${rawKey ? `'${rawKey}'` : 'NULL'},
              'videos/${videoId}/', '${opts.status ?? 'pending'}',
              ${opts.notBefore ?? 'now() - interval \'1 minute\''})
    `)
  }

  const deps = (store: ObjectStore, overrides: Partial<CleanupDeps> = {}): CleanupDeps => ({
    executor: handle.db as never,
    objectStore: store,
    rawBucket: RAW_BUCKET,
    transcodedBucket: TRANSCODED_BUCKET,
    now: () => new Date(),
    limits: DEFAULT_CLEANUP_LIMITS,
    ...overrides,
  })

  const readJob = async (videoId: string) =>
    normalizeRows(
      await handle.db.execute(
        sql`SELECT status, attempts, objects_deleted, last_error, verified_at, reclaimed_at
            FROM storage_cleanup_job WHERE video_id = ${videoId}`,
      ),
    )[0]

  it('reclaims a deleted video\u2019s objects and raw upload', async () => {
    await seedJob(VIDEO_1, 'orgs/x/raw/a.mp4')
    const fake = fakeStore({
      [TRANSCODED_BUCKET]: [
        `videos/${VIDEO_1}/playlist.m3u8`,
        `videos/${VIDEO_1}/video_720p/init.mp4`,
      ],
      [RAW_BUCKET]: ['orgs/x/raw/a.mp4'],
    })

    const stats = await runObjectCleanup(deps(fake.store))

    // Assert on this job rather than a global counter: the reconciler is
    // global by design, so other suites' videos can legitimately be reclaimed
    // in the same pass.
    expect(await fake.store.listKeys(TRANSCODED_BUCKET, `videos/${VIDEO_1}/`)).toEqual([])
    expect(stats.objectsDeleted).toBeGreaterThanOrEqual(3)

    const job = await readJob(VIDEO_1)
    expect(job?.status).toBe('reclaimed')
    expect(job?.reclaimed_at).not.toBeNull()
    expect(Number(job?.objects_deleted)).toBe(3)
  })

  it('does not touch bytes until the writer-retirement window has passed', async () => {
    await seedJob(VIDEO_2, null, { notBefore: "now() + interval '1 hour'" })
    const fake = fakeStore({ [TRANSCODED_BUCKET]: [`videos/${VIDEO_2}/playlist.m3u8`] })

    const stats = await runObjectCleanup(deps(fake.store))

    expect(stats.jobsReclaimed).toBe(0)
    expect(stats.objectsDeleted).toBe(0)
    // The object is still there and the job is still pending.
    expect(await fake.store.listKeys(TRANSCODED_BUCKET, `videos/${VIDEO_2}/`)).toHaveLength(1)
    expect((await readJob(VIDEO_2))?.status).toBe('pending')
  })

  it('waits for a live transcode attempt even when not_before has passed', async () => {
    await seedJob(VIDEO_2, null)
    await handle.exec(`
      INSERT INTO video (id, organization_id, title, status, deleted_at,
                         transcode_attempt_id, transcode_lease_expires_at)
      VALUES ('${VIDEO_2}', '${ORG}', 'Late writer', 'processing', now(),
              'att-live', now() + interval '10 minutes')
      ON CONFLICT (id) DO UPDATE SET deleted_at = now(),
        transcode_attempt_id = 'att-live',
        transcode_lease_expires_at = now() + interval '10 minutes';
    `)
    const fake = fakeStore({ [TRANSCODED_BUCKET]: [`videos/${VIDEO_2}/playlist.m3u8`] })

    const stats = await runObjectCleanup(deps(fake.store))

    // A writer that may still legitimately write must not be deleted underneath.
    expect(stats.objectsDeleted).toBe(0)
    expect(await fake.store.listKeys(TRANSCODED_BUCKET, `videos/${VIDEO_2}/`)).toHaveLength(1)

    // Once the attempt's lease lapses, the same pass reclaims it.
    await handle.exec(`
      UPDATE video SET transcode_lease_expires_at = now() - interval '1 minute'
      WHERE id = '${VIDEO_2}'
    `)
    const after = await runObjectCleanup(deps(fake.store))
    expect(after.jobsReclaimed).toBe(1)
    expect(await fake.store.listKeys(TRANSCODED_BUCKET, `videos/${VIDEO_2}/`)).toEqual([])
  })

  it('re-opens a reclaimed job when an object reappears (late writer)', async () => {
    await seedJob(VIDEO_1, null)
    const fake = fakeStore({ [TRANSCODED_BUCKET]: [] })

    // First pass reclaims: listing is empty.
    expect((await runObjectCleanup(deps(fake.store))).jobsReclaimed).toBe(1)

    // A writer lands after the reclaim — the case that made "one empty listing"
    // an unsound completion rule.
    fake.put(TRANSCODED_BUCKET, `videos/${VIDEO_1}/video_1080p/9.m4s`)
    await handle.exec(`
      UPDATE storage_cleanup_job SET reclaimed_at = now() - interval '2 hours'
      WHERE video_id = '${VIDEO_1}'
    `)

    const recheck = await runObjectCleanup(deps(fake.store))

    // The job was reopened — the late write was noticed rather than believed
    // away — and the same pass then reclaimed the straggler.
    expect(recheck.jobsReopened).toBe(1)
    expect(recheck.jobsReclaimed).toBe(1)
    expect(await fake.store.listKeys(TRANSCODED_BUCKET, `videos/${VIDEO_1}/`)).toEqual([])
    expect((await readJob(VIDEO_1))?.status).toBe('reclaimed')
  })

  it('marks a job failed once the attempt budget is spent, without reclaiming', async () => {
    await seedJob(VIDEO_2, null)
    await handle.exec(`DELETE FROM video WHERE id = '${VIDEO_2}'`)
    await handle.exec(`
      UPDATE storage_cleanup_job
      SET attempts = ${DEFAULT_CLEANUP_LIMITS.maxAttempts}
      WHERE video_id = '${VIDEO_2}'
    `)

    // A store that refuses to delete anything.
    const stuck: ObjectStore = {
      async listKeys() {
        return [`videos/${VIDEO_2}/playlist.m3u8`]
      },
      async deleteKeys() {
        return 0
      },
      async abortMultipartUploads() {
        return 0
      },
    }

    const stats = await runObjectCleanup(deps(stuck))
    expect(stats.jobsFailed).toBe(1)
    expect(stats.jobsReclaimed).toBe(0)

    const job = await readJob(VIDEO_2)
    expect(job?.status).toBe('failed')
    expect(String(job?.last_error)).toContain('1 object(s)')
  })

  it('lets only one of two concurrent runners claim the same job', async () => {
    await seedJob(VIDEO_1, null)
    const racer = createTestDb({ max: 1 })
    const fake = fakeStore({ [TRANSCODED_BUCKET]: [] })

    try {
      const [a, b] = await Promise.all([
        claimCleanupJobs(10, deps(fake.store)),
        claimCleanupJobs(10, deps(fake.store, { executor: racer.db as never })),
      ])
      expect([...a, ...b].filter((job) => job.videoId === VIDEO_1)).toHaveLength(1)
    } finally {
      await racer.close()
    }
  })
})
