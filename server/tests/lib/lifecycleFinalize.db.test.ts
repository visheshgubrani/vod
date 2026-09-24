/**
 * Lifecycle finalization against a real PostgreSQL.
 *
 * Publication is the point where a viewer either gets bytes or a 404, and the
 * guarantees are all database-level: the ownership guard, the verification gate,
 * the outbox row written in the same statement, and the atomic pairing of
 * publication with the local job's own terminal state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { attemptPrefix, finalizeAndSucceed, finalizeVideoFailure, finalizeVideoSuccess } from '../../src/lib/lifecycleFinalize'
import { eventOutbox, transcodeJob, video } from '../../src/db/schema'
import { buildSucceedJobStatement } from '../../src/lib/localJobQueue'
import { createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'

const ORG = 'org-lifecycle'
const VIDEO = '11111111-1111-1111-1111-111111111111'
const VIDEO_2 = '22222222-2222-2222-2222-222222222222'
const VIDEO_3 = '33333333-3333-3333-3333-333333333333'
const VIDEO_4 = '44444444-4444-4444-4444-444444444444'
const ATTEMPT = 'att-life'
const JOB = 'aaaaaaaa-0000-0000-0000-00000000000a'
const DELIVERY = 'https://delivery.example.com'

const SUCCESS_PAYLOAD = {
  status: 'success',
  video_id: VIDEO,
  metadata: { width: 1920, height: 1080, duration: 61.4, fps: 30, has_audio: true },
  outputs: {
    renditions: ['1080p', '720p'],
    hls_playlist: 'playlist.m3u8',
    dash_manifest: 'manifest.mpd',
    poster: 'poster.jpg',
  },
  processing: { total_time: 120, transcode_time: 90, transcoded_size: 1234 },
  subtitle: { requested: false },
  chapters: { requested: false },
  playback_policy: 'public',
}

describe.skipIf(!hasTestDatabase)('lifecycleFinalize (PostgreSQL)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'lifecycle_suite', max: 2 })
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG}', 'Lifecycle', 'lifecycle', now());
      INSERT INTO video (id, organization_id, title, status, transcode_attempt_id, transcode_lease_expires_at)
      VALUES
        ('${VIDEO}', '${ORG}', 'One', 'processing', '${ATTEMPT}', now() + interval '10 minutes'),
        ('${VIDEO_2}', '${ORG}', 'Two', 'processing', 'att-other', now() + interval '10 minutes'),
        ('${VIDEO_3}', '${ORG}', 'Three', 'processing', 'att-job', now() + interval '10 minutes'),
        ('${VIDEO_4}', '${ORG}', 'Four', 'processing', 'att-fail', now() + interval '10 minutes');
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner, lease_expires_at)
      VALUES ('${JOB}', '${VIDEO_3}', '${ORG}', 'local', 'running', 'att-job', 'local', now() + interval '10 minutes');
    `)
  })

  afterAll(async () => {
    await handle?.close()
  })

  const successInput = (videoId: string, attemptId: string, prefix: string) => ({
    videoId,
    organizationId: ORG,
    title: 'One',
    attemptId,
    payload: SUCCESS_PAYLOAD as Record<string, unknown>,
    outputPrefix: prefix,
    deliveryBaseUrl: DELIVERY,
    prevMetadata: {},
  })

  it('publishes an attempt-prefixed URL and records the outbox event', async () => {
    const prefix = attemptPrefix(VIDEO, ATTEMPT)
    const result = await finalizeVideoSuccess(handle.db, successInput(VIDEO, ATTEMPT, prefix))

    expect(result.applied).toBe(true)
    const [row] = await handle.db.select().from(video).where(eq(video.id, VIDEO))
    expect(row.status).toBe('ready')
    expect(row.hlsUrl).toBe(`${DELIVERY}/${prefix}/playlist.m3u8`)
    expect(row.thumbnailUrl).toBe(`${DELIVERY}/${prefix}/poster.jpg`)
    expect(row.transcodeAttemptId).toBeNull()

    if (result.applied) {
      const events = await handle.db
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.id, result.eventId))
      expect(events).toHaveLength(1)
      expect(events[0].event).toBe('video.ready')
    }
  })

  it('refuses a callback from an attempt that no longer owns the video', async () => {
    const result = await finalizeVideoSuccess(
      handle.db,
      successInput(VIDEO_2, 'att-stale', attemptPrefix(VIDEO_2, 'att-stale')),
    )
    expect(result.applied).toBe(false)

    const [row] = await handle.db.select().from(video).where(eq(video.id, VIDEO_2))
    expect(row.status).toBe('processing')
  })

  it('never resurrects a deleted video', async () => {
    await handle.exec(`UPDATE video SET deleted_at = now() WHERE id = '${VIDEO_2}'`)
    const result = await finalizeVideoSuccess(
      handle.db,
      successInput(VIDEO_2, 'att-other', attemptPrefix(VIDEO_2, 'att-other')),
    )
    expect(result.applied).toBe(false)
    await handle.exec(`UPDATE video SET deleted_at = NULL WHERE id = '${VIDEO_2}'`)
  })

  it('is idempotent: a replayed success changes nothing and writes no second event', async () => {
    const before = await handle.db.select().from(eventOutbox)
    const result = await finalizeVideoSuccess(
      handle.db,
      successInput(VIDEO, ATTEMPT, attemptPrefix(VIDEO, ATTEMPT)),
    )
    expect(result.applied).toBe(false)
    const after = await handle.db.select().from(eventOutbox)
    expect(after).toHaveLength(before.length)
  })

  it('requires a verified inventory when asked to', async () => {
    const unverified = await finalizeVideoSuccess(handle.db, {
      ...successInput(VIDEO_2, 'att-other', attemptPrefix(VIDEO_2, 'att-other')),
      requireVerifiedInventory: true,
    })
    expect(unverified.applied).toBe(false)
  })

  it('fails a video and records the failure event in one write', async () => {
    const result = await finalizeVideoFailure(handle.db, {
      videoId: VIDEO_4,
      organizationId: ORG,
      title: 'Four',
      attemptId: 'att-fail',
      message: 'encoder died',
      failureCode: 'ENCODER_FAILED',
      prevMetadata: {},
    })

    expect(result.applied).toBe(true)
    const [row] = await handle.db.select().from(video).where(eq(video.id, VIDEO_4))
    expect(row.status).toBe('failed')
    expect(row.failureCode).toBe('ENCODER_FAILED')
    expect(row.transcodeAttemptId).toBeNull()
  })

  it('publishes the video and finishes the job in one transaction', async () => {
    // Register a verified inventory for the job's attempt.
    const { registerInventory, applyVerification } = await import('../../src/lib/artifactInventory')
    const prefix = attemptPrefix(VIDEO_3, 'att-job')
    const { inventoryId } = await registerInventory(handle.db, {
      videoId: VIDEO_3,
      organizationId: ORG,
      jobId: JOB,
      attemptId: 'att-job',
      prefix,
      artifacts: [{ path: 'playlist.m3u8', size: 10, role: 'playlist' }],
    })
    await applyVerification(handle.db, {
      inventoryId,
      verified: ['playlist.m3u8'],
      failed: [],
    })

    const result = await finalizeAndSucceed(
      handle.db,
      {
        ...successInput(VIDEO_3, 'att-job', prefix),
        title: 'Three',
        jobId: JOB,
        requireVerifiedInventory: true,
        publishedPrefix: prefix,
      },
      (jobId, attemptId) => buildSucceedJobStatement({ jobId, attemptId }),
    )

    expect(result.applied).toBe(true)

    const [row] = await handle.db.select().from(video).where(eq(video.id, VIDEO_3))
    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, JOB))
    // Both writes landed. Split across two statements there was a window where a
    // crash left the video ready and the job publishing, and the replay could
    // never repair it.
    expect(row.status).toBe('ready')
    expect(job.state).toBe('succeeded')
    expect(job.finishedAt).not.toBeNull()
  })

  it('rolls back publication when the job write cannot apply', async () => {
    // A guarded UPDATE that matches nothing is not an error, so a transaction
    // whose *second* statement silently no-ops still commits — leaving the video
    // published beside a job that never finished. Here the job has already
    // reached a terminal state while the video has not, so publication would
    // apply and the job write would not: the split must roll back rather than
    // commit half of it.
    const { registerInventory, applyVerification } = await import('../../src/lib/artifactInventory')
    await handle.exec(`
      INSERT INTO video (id, organization_id, title, status, transcode_attempt_id, transcode_lease_expires_at)
      VALUES ('55555555-5555-5555-5555-555555555555', '${ORG}', 'Five', 'processing', 'att-five', now() + interval '10 minutes');
      INSERT INTO transcode_job (id, video_id, organization_id, provider, state, attempt_id, lease_owner)
      VALUES ('bbbbbbbb-0000-0000-0000-00000000000b', '55555555-5555-5555-5555-555555555555',
              '${ORG}', 'local', 'succeeded', 'att-five', NULL);
    `)
    const videoId = '55555555-5555-5555-5555-555555555555'
    const jobId = 'bbbbbbbb-0000-0000-0000-00000000000b'
    const prefix = attemptPrefix(videoId, 'att-five')
    const { inventoryId } = await registerInventory(handle.db, {
      videoId,
      organizationId: ORG,
      jobId,
      attemptId: 'att-five',
      prefix,
      artifacts: [{ path: 'playlist.m3u8', size: 10, role: 'playlist' }],
    })
    await applyVerification(handle.db, { inventoryId, verified: ['playlist.m3u8'], failed: [] })

    await expect(
      finalizeAndSucceed(
        handle.db,
        {
          ...successInput(videoId, 'att-five', prefix),
          title: 'Five',
          jobId,
          requireVerifiedInventory: true,
          publishedPrefix: prefix,
        },
        (id, attemptId) => buildSucceedJobStatement({ jobId: id, attemptId }),
      ),
    ).rejects.toThrow(/diverged/)

    const [row] = await handle.db.select().from(video).where(eq(video.id, videoId))
    const [job] = await handle.db.select().from(transcodeJob).where(eq(transcodeJob.id, jobId))
    expect(row.status).toBe('processing')
    expect(job.state).toBe('succeeded')

    const events = await handle.db
      .select()
      .from(eventOutbox)
      .where(
        and(eq(eventOutbox.event, 'video.ready'), eq(eventOutbox.organizationId, ORG)),
      )
    // No ready event for this video.
    expect(events.some((event) => (event.payload as { videoId?: string }).videoId === videoId)).toBe(
      false,
    )
  })
})
