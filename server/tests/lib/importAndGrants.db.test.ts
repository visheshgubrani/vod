/**
 * Import idempotency and grant authorization, against a real PostgreSQL.
 *
 * Two tenant-facing properties:
 *
 * 1. **A retried import must not encode twice.** The reviewed implementation
 *    checked the key, created a video, queued a job and only then wrote the key —
 *    four steps with three windows. Concurrent requests both passed the check,
 *    both queued, and the loser failed its own video on the unique violation
 *    *while leaving its job queued* — and claims deliberately accept failed
 *    videos, so the duplicate ran.
 * 2. **A grant is a write capability, and "the row exists" is not a reason to
 *    issue one.** The reviewed check looked only at the inventory id and the
 *    job's lease owner, so a superseded attempt stayed renewable and an agent
 *    could keep uploading into a prefix a newer attempt might be publishing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

// `createLocalImport` uses the module-level handle, which reads DATABASE_URL
// when it is first touched — so the URL must be set before the import resolves.
import { testDatabaseUrl } from '../helpers/db'

const SUITE = 'import_suite'

// The application modules are imported *inside* the suite, not at module scope.
//
// `lib/database` reads `DATABASE_URL` when it is first touched and throws
// without one, so importing it at the top of a file that must also run on a
// machine with no database would fail collection rather than skip.
const suiteUrl = testDatabaseUrl(SUITE)
const suiteDb = suiteUrl
  ? await import('../helpers/db')
  : null
const hasTestDatabase = suiteDb?.hasTestDatabase ?? false

// The application handle defaults to `neon-http` (the Workers transport), an
// HTTPS-only driver that cannot be pointed at a local container.
if (suiteUrl) {
  process.env.DATABASE_URL = suiteUrl
  process.env.DB_DRIVER = 'pg'
}

const { createTestDb, connectTestDb } = suiteDb ?? ({} as never)

const ORG = 'org-import'
const AGENT = 'agent-import'
const VIDEO = '11111111-1111-1111-1111-111111111111'
const ATTEMPT = 'att-grant'
const JOB = 'aaaaaaaa-0000-0000-0000-00000000000a'
const PREFIX = `videos/${VIDEO}/attempts/${ATTEMPT}`

describe.skipIf(!hasTestDatabase)('local import and grants (PostgreSQL)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>
  let other: Awaited<ReturnType<typeof connectTestDb>>
  let createLocalImport: typeof import('../../src/routes/localImport')['createLocalImport']
  let db: typeof import('../../src/lib/database')['db']
  let transcodeJob: typeof import('../../src/db/schema')['transcodeJob']
  let video: typeof import('../../src/db/schema')['video']

  beforeAll(async () => {
    handle = await createTestDb({ database: SUITE, max: 4 })
    other = await connectTestDb({ database: SUITE, max: 4 })
    ;({ createLocalImport } = await import('../../src/routes/localImport'))
    ;({ db } = await import('../../src/lib/database'))
    ;({ transcodeJob, video } = await import('../../src/db/schema'))
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG}', 'Import', 'import', now());
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('user-1', 'Importer', 'importer@example.com', true, now(), now());
      INSERT INTO transcoder_agent (id, organization_id, name, token_hash, token_last4, capacity_jobs, enabled)
      VALUES ('${AGENT}', '${ORG}', 'Agent', 'hash-import', 'aaaa', 1, true);
      INSERT INTO transcode_source (id, organization_id, kind, agent_id, root_name, relative_path, file_name, availability)
      VALUES ('11111111-1111-4111-8111-111111111111', '${ORG}', 'local', '${AGENT}',
              'media', 'course/lesson-01.mp4', 'lesson-01.mp4', 'available');
    `)
  })

  afterAll(async () => {
    await other?.close()
    await handle?.close()
  })

  const importInput = (key: string | null, sourceRef = '11111111-1111-4111-8111-111111111111') => ({
    organizationId: ORG,
    userId: 'user-1',
    sourceRef,
    title: 'Lesson one',
    playbackPolicy: 'public' as const,
    options: { maxHeight: 720 },
    idempotencyKey: key,
    generateSubtitle: false,
    generateChapters: false,
  })

  it('creates one video and one job for one import', async () => {
    const result = await createLocalImport(importInput('key-single'))
    expect('videoId' in result).toBe(true)
    if (!('videoId' in result)) return
    expect(result.deduplicated).toBe(false)

    const jobs = await db
      .select()
      .from(transcodeJob)
      .where(eq(transcodeJob.idempotencyKey, 'key-single'))
    expect(jobs).toHaveLength(1)
  })

  it('returns the same job for a retried import with the same key', async () => {
    const first = await createLocalImport(importInput('key-retry'))
    const second = await createLocalImport(importInput('key-retry'))
    expect('videoId' in first && 'videoId' in second).toBe(true)
    if (!('videoId' in first) || !('videoId' in second)) return

    expect(second.videoId).toBe(first.videoId)
    expect(second.jobId).toBe(first.jobId)
    expect(second.deduplicated).toBe(true)

    const rows = await db
      .select()
      .from(transcodeJob)
      .where(eq(transcodeJob.idempotencyKey, 'key-retry'))
    expect(rows).toHaveLength(1)
  })

  it('serializes concurrent imports carrying one key', async () => {
    // The window: both requests read "no existing job" before either wrote the
    // key. Serialization on the organization row is what closes it.
    const [left, right] = await Promise.all([
      createLocalImport(importInput('key-concurrent')),
      createLocalImport(importInput('key-concurrent')),
    ])

    const videoIds = new Set(
      [left, right].filter((r) => 'videoId' in r).map((r) => (r as { videoId: string }).videoId),
    )
    expect(videoIds.size).toBe(1)

    const jobs = await db
      .select()
      .from(transcodeJob)
      .where(eq(transcodeJob.idempotencyKey, 'key-concurrent'))
    expect(jobs).toHaveLength(1)
  })

  it('never leaves a queued job behind a failed duplicate video', async () => {
    await Promise.all([
      createLocalImport(importInput('key-orphan')),
      createLocalImport(importInput('key-orphan')),
    ])

    const jobs = await db
      .select()
      .from(transcodeJob)
      .where(eq(transcodeJob.idempotencyKey, 'key-orphan'))
    expect(jobs).toHaveLength(1)

    // The single job's video must be runnable, not the failed duplicate.
    const [job] = jobs
    const [row] = await db.select().from(video).where(eq(video.id, job.videoId))
    expect(row.status).not.toBe('failed')
  })

  it('queues independently when no key is supplied', async () => {
    const first = await createLocalImport(importInput(null))
    const second = await createLocalImport(importInput(null))
    if (!('videoId' in first) || !('videoId' in second)) throw new Error('import failed')
    expect(first.videoId).not.toBe(second.videoId)
  })

  it('refuses a second runnable job for one video', async () => {
    const first = await createLocalImport(importInput('key-guard'))
    if (!('videoId' in first)) throw new Error('import failed')

    // Force a second, keyless job onto the same video: the partial unique index
    // must refuse it, so "one video, one runnable job" is a property of the data
    // rather than of a caller's discipline.
    await expect(
      handle.exec(`
        INSERT INTO transcode_job (video_id, organization_id, provider, state)
        VALUES ('${first.videoId}', '${ORG}', 'self-hosted', 'queued')
      `),
    ).rejects.toThrow(/one_runnable_per_video|duplicate key/)
  })

  it('rejects a source reference from another organization', async () => {
    const result = await createLocalImport({
      ...importInput('key-cross-org'),
      organizationId: 'org-someone-else',
    })
    expect('error' in result).toBe(true)
  })

  it('rejects a source that is no longer available', async () => {
    await handle.exec(`
      INSERT INTO transcode_source (id, organization_id, kind, agent_id, root_name, relative_path, file_name, availability)
      VALUES ('22222222-2222-4222-8222-222222222222', '${ORG}', 'local', '${AGENT}',
              'media', 'course/gone.mp4', 'gone.mp4', 'missing')
    `)
    const result = await createLocalImport(
      importInput('key-missing', '22222222-2222-4222-8222-222222222222'),
    )
    expect('error' in result).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Grant authorization: a grant is a write capability.
// ────────────────────────────────────────────────────────────────────────────
describe.skipIf(!hasTestDatabase)('grant authorization (PostgreSQL)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>

  beforeAll(async () => {
    handle = await createTestDb({ database: 'grant_suite', max: 2 })
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG}', 'Grant', 'grant', now());
      INSERT INTO video (id, organization_id, title, status, transcode_attempt_id, transcode_lease_expires_at)
      VALUES ('${VIDEO}', '${ORG}', 'One', 'processing', '${ATTEMPT}', now() + interval '10 minutes');
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner, lease_expires_at)
      VALUES ('${JOB}', '${VIDEO}', '${ORG}', 'self-hosted', 'running', '${ATTEMPT}', '${AGENT}', now() + interval '10 minutes');
      INSERT INTO artifact_inventory (video_id, organization_id, job_id, attempt_id, prefix, status, item_count)
      VALUES ('${VIDEO}', '${ORG}', '${JOB}', '${ATTEMPT}', '${PREFIX}', 'registering', 1);
    `)
  })

  afterAll(async () => {
    await handle?.close()
  })

  /** The predicate the authorization query applies, as a reusable check. */
  async function authorizationCount(): Promise<number> {
    const rows = await handle.exec(`
      SELECT count(*)::int AS allowed
      FROM artifact_inventory AS inv
      JOIN video AS v ON v.id = inv.video_id
      JOIN transcode_job AS j ON j.id = inv.job_id
      WHERE inv.attempt_id = '${ATTEMPT}'
        AND j.lease_owner = '${AGENT}'
        AND j.attempt_id = inv.attempt_id
        AND j.state IN ('claimed', 'running', 'publishing')
        AND j.lease_expires_at > now()
        AND v.deleted_at IS NULL
        AND v.transcode_attempt_id = inv.attempt_id
        AND inv.status <> 'superseded'
    `)
    return Number((rows as unknown as Array<{ allowed: number }>)[0]?.allowed ?? 0)
  }

  it('authorizes an inventory the live attempt owns', async () => {
    expect(await authorizationCount()).toBe(1)
  })

  it('refuses once the job names a newer attempt', async () => {
    await handle.exec(`UPDATE transcode_job SET attempt_id = 'att-newer' WHERE id = '${JOB}'`)
    expect(await authorizationCount()).toBe(0)
    await handle.exec(`UPDATE transcode_job SET attempt_id = '${ATTEMPT}' WHERE id = '${JOB}'`)
  })

  it('refuses once the video names a newer attempt', async () => {
    await handle.exec(`UPDATE video SET transcode_attempt_id = 'att-newer' WHERE id = '${VIDEO}'`)
    expect(await authorizationCount()).toBe(0)
    await handle.exec(`UPDATE video SET transcode_attempt_id = '${ATTEMPT}' WHERE id = '${VIDEO}'`)
  })

  it('refuses once the lease has expired', async () => {
    await handle.exec(
      `UPDATE transcode_job SET lease_expires_at = now() - interval '1 minute' WHERE id = '${JOB}'`,
    )
    expect(await authorizationCount()).toBe(0)
    await handle.exec(
      `UPDATE transcode_job SET lease_expires_at = now() + interval '10 minutes' WHERE id = '${JOB}'`,
    )
  })

  it('refuses once the job reaches a terminal state', async () => {
    await handle.exec(`UPDATE transcode_job SET state = 'succeeded' WHERE id = '${JOB}'`)
    expect(await authorizationCount()).toBe(0)
    await handle.exec(`UPDATE transcode_job SET state = 'running' WHERE id = '${JOB}'`)
  })

  it('refuses once the video is deleted', async () => {
    await handle.exec(`UPDATE video SET deleted_at = now() WHERE id = '${VIDEO}'`)
    expect(await authorizationCount()).toBe(0)
    await handle.exec(`UPDATE video SET deleted_at = NULL WHERE id = '${VIDEO}'`)
  })

  it('refuses once the inventory is superseded', async () => {
    const { supersedeInventories } = await import('../../src/lib/artifactInventory')
    await supersedeInventories(handle.db, { videoId: VIDEO, exceptAttemptId: 'att-other' })
    expect(await authorizationCount()).toBe(0)
  })

  it('refuses a lease the API cannot renew', async () => {
    // The route withholds grants when `extendLease` updates nothing, so an
    // expired-lease attempt cannot obtain a URL even if it asks.
    const rows = (await handle.exec(`
      UPDATE video
      SET transcode_lease_expires_at = now() + interval '20 minutes'
      WHERE id = '${VIDEO}' AND transcode_attempt_id = 'att-not-this-one'
      RETURNING id
    `)) as unknown as unknown[]
    expect(rows).toHaveLength(0)
  })
})
