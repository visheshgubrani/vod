/**
 * Artifact inventory against a real PostgreSQL.
 *
 * Verification is the gate that decides whether a video becomes playable, so the
 * claims below are about what the tables contain after a real call — not about
 * whether the SQL text contains a guard. Both defects this suite covers were
 * invisible to substring assertions: one statement PostgreSQL refused outright,
 * and one that ran and read a snapshot taken before its own updates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  applyVerification,
  authorizeArtifactPath,
  markArtifactsUploaded,
  readInventoryForAttempt,
  readPendingArtifacts,
  readRemainingCount,
  readVerificationCandidates,
  registerInventory,
  registerInventoryPaged,
  supersedeInventories,
} from '../../src/lib/artifactInventory'
import { artifactInventory, artifactInventoryItem } from '../../src/db/schema'
import { createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'

const ORG = 'org-inv'
const VIDEO = '11111111-1111-1111-1111-111111111111'
const VIDEO_2 = '22222222-2222-2222-2222-222222222222'
const ATTEMPT = 'att-inv-1'
const PREFIX = `videos/${VIDEO}/attempts/${ATTEMPT}`

describe.skipIf(!hasTestDatabase)('artifactInventory (PostgreSQL)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'inventory_suite', max: 2 })
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG}', 'Inv', 'inv', now());
      INSERT INTO video (id, organization_id, title, status)
      VALUES ('${VIDEO}', '${ORG}', 'One', 'processing'), ('${VIDEO_2}', '${ORG}', 'Two', 'processing');
    `)
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function register(paths: string[], attemptId = ATTEMPT, videoId = VIDEO) {
    return registerInventory(handle.db, {
      videoId,
      organizationId: ORG,
      jobId: null,
      attemptId,
      prefix: `videos/${videoId}/attempts/${attemptId}`,
      artifacts: paths.map((path, index) => ({
        path,
        size: 100 + index,
        checksum: `sum-${path}`,
        role: path.endsWith('.m3u8') ? 'playlist' : 'segment',
      })),
    })
  }

  it('registers an inventory and reads its items back', async () => {
    const result = await register(['playlist.m3u8', 'video_720p/1.m4s'])
    expect(result.items).toBe(2)
    expect(result.status).toBe('registering')

    const pending = await readPendingArtifacts(handle.db, {
      inventoryId: result.inventoryId,
      attemptId: ATTEMPT,
    })
    // Playlists last, so a player never fetches a manifest before its segments.
    expect(pending.map((entry) => entry.path)).toEqual(['video_720p/1.m4s', 'playlist.m3u8'])
  })

  it('completes verification and recounts from the updated rows', async () => {
    const { inventoryId } = await register(['playlist.m3u8', 'video_720p/1.m4s'], 'att-verify')

    const partial = await applyVerification(handle.db, {
      inventoryId,
      verified: ['playlist.m3u8'],
      failed: [],
    })
    expect(partial?.verified).toBe(1)
    expect(partial?.total).toBe(2)
    expect(partial?.status).toBe('registering')

    const complete = await applyVerification(handle.db, {
      inventoryId,
      verified: ['video_720p/1.m4s'],
      failed: [],
    })
    // The recount must see the rows this call just changed. Reading the
    // statement's original snapshot reported zero and left the inventory
    // `registering`, which the agent — correctly — treats as failure.
    expect(complete?.status).toBe('verified')
    expect(complete?.verified).toBe(2)

    const items = await handle.db
      .select()
      .from(artifactInventoryItem)
      .where(eq(artifactInventoryItem.inventoryId, inventoryId))
    expect(items.every((item) => item.status === 'verified')).toBe(true)
  })

  it('accepts a single-artifact verification', async () => {
    // The nested-VALUES defect failed *every* request, including this one.
    const { inventoryId } = await register(['playlist.m3u8'], 'att-single')
    const result = await applyVerification(handle.db, {
      inventoryId,
      verified: ['playlist.m3u8'],
      failed: [],
    })
    expect(result?.status).toBe('verified')
  })

  it('accepts an empty batch without a syntax error', async () => {
    const { inventoryId } = await register(['playlist.m3u8'], 'att-empty')
    const result = await applyVerification(handle.db, {
      inventoryId,
      verified: [],
      failed: [],
    })
    expect(result).not.toBeNull()
    expect(result?.status).toBe('registering')
  })

  it('marks an inventory failed when an artifact fails verification', async () => {
    const { inventoryId } = await register(['playlist.m3u8', 'video_720p/1.m4s'], 'att-bad')
    const result = await applyVerification(handle.db, {
      inventoryId,
      verified: ['playlist.m3u8'],
      failed: [{ path: 'video_720p/1.m4s', reason: 'object is missing' }],
    })
    expect(result?.status).toBe('failed')
    expect(result?.verified).toBe(1)

    const items = await handle.db
      .select()
      .from(artifactInventoryItem)
      .where(eq(artifactInventoryItem.inventoryId, inventoryId))
    const failed = items.find((item) => item.path === 'video_720p/1.m4s')
    expect(failed?.error).toBe('object is missing')
  })

  it('re-verifies an item that previously failed', async () => {
    const { inventoryId } = await register(['playlist.m3u8'], 'att-recover')
    await applyVerification(handle.db, {
      inventoryId,
      verified: [],
      failed: [{ path: 'playlist.m3u8', reason: 'missing' }],
    })
    const recovered = await applyVerification(handle.db, {
      inventoryId,
      verified: ['playlist.m3u8'],
      failed: [],
    })
    // Exactly one item, so a recovery must not double-count to 2 of 1.
    expect(recovered?.status).toBe('verified')
    expect(recovered?.verified).toBe(1)
    expect(recovered?.total).toBe(1)
  })

  it('pages registration and appends rather than replacing', async () => {
    const artifacts = Array.from({ length: 7 }, (_, index) => ({
      path: `video_720p/${index}.m4s`,
      size: 10,
    }))
    const result = await registerInventoryPaged(
      handle.db,
      {
        videoId: VIDEO,
        organizationId: ORG,
        jobId: null,
        attemptId: 'att-paged',
        prefix: `videos/${VIDEO}/attempts/att-paged`,
        artifacts,
      },
      3,
    )

    expect(result.items).toBe(7)
    const items = await handle.db
      .select()
      .from(artifactInventoryItem)
      .where(eq(artifactInventoryItem.inventoryId, result.inventoryId))
    expect(items).toHaveLength(7)
  })

  it('re-registering replaces the previous plan', async () => {
    const first = await register(['a.m4s', 'b.m4s'], 'att-replace')
    const second = await register(['c.m4s'], 'att-replace')
    expect(second.inventoryId).toBe(first.inventoryId)

    const items = await handle.db
      .select()
      .from(artifactInventoryItem)
      .where(eq(artifactInventoryItem.inventoryId, first.inventoryId))
    expect(items.map((item) => item.path)).toEqual(['c.m4s'])
  })

  it('bounds the verification candidate list', async () => {
    const artifacts = Array.from({ length: 12 }, (_, index) => ({
      path: `seg/${index}.m4s`,
      size: 10,
    }))
    const { inventoryId } = await registerInventoryPaged(
      handle.db,
      {
        videoId: VIDEO,
        organizationId: ORG,
        jobId: null,
        attemptId: 'att-bounded',
        prefix: `videos/${VIDEO}/attempts/att-bounded`,
        artifacts,
      },
      50,
    )

    const page = await readVerificationCandidates(handle.db, { inventoryId, limit: 5 })
    expect(page).toHaveLength(5)
    expect(await readRemainingCount(handle.db, { inventoryId })).toBe(12)

    await applyVerification(handle.db, {
      inventoryId,
      verified: page.map((entry) => entry.path),
      failed: [],
    })
    expect(await readRemainingCount(handle.db, { inventoryId })).toBe(7)
  })

  it('marks uploaded artifacts without claiming they are verified', async () => {
    const { inventoryId } = await register(['playlist.m3u8'], 'att-uploaded')
    const updated = await markArtifactsUploaded(handle.db, {
      inventoryId,
      paths: ['playlist.m3u8', 'not-in-the-inventory.m4s'],
      checksums: { 'playlist.m3u8': 'abc' },
    })
    // Only inventory rows are touched: an invented path changes nothing.
    expect(updated).toBe(1)

    const [item] = await handle.db
      .select()
      .from(artifactInventoryItem)
      .where(eq(artifactInventoryItem.inventoryId, inventoryId))
    expect(item.status).toBe('uploaded')
    expect(item.verifiedAt).toBeNull()
    expect(item.checksum).toBe('abc')
  })

  it('retires a superseded attempt so its grants stop being renewable', async () => {
    await register(['playlist.m3u8'], 'att-old', VIDEO_2)
    await register(['playlist.m3u8'], 'att-new', VIDEO_2)

    const retired = await supersedeInventories(handle.db, {
      videoId: VIDEO_2,
      exceptAttemptId: 'att-new',
    })
    expect(retired).toBe(1)

    const old = await readInventoryForAttempt(handle.db, {
      videoId: VIDEO_2,
      attemptId: 'att-old',
    })
    const current = await readInventoryForAttempt(handle.db, {
      videoId: VIDEO_2,
      attemptId: 'att-new',
    })
    expect(old?.status).toBe('superseded')
    expect(current?.status).not.toBe('superseded')
  })

  it('keeps each attempt’s inventory separate', async () => {
    await register(['playlist.m3u8'], 'att-sep-1')
    await register(['playlist.m3u8'], 'att-sep-2')

    const rows = await handle.db
      .select()
      .from(artifactInventory)
      .where(eq(artifactInventory.videoId, VIDEO))
    const attempts = rows.map((row) => row.attemptId)
    expect(new Set(attempts).size).toBe(attempts.length)
  })

  it('authorizes only inventory-listed paths inside the attempt prefix', () => {
    const inventory = new Set(['playlist.m3u8'])
    expect(authorizeArtifactPath(PREFIX, inventory, 'playlist.m3u8').allowed).toBe(true)
    expect(authorizeArtifactPath(PREFIX, inventory, '../playlist.m3u8').allowed).toBe(false)
    expect(authorizeArtifactPath(PREFIX, inventory, 'other.m4s').allowed).toBe(false)
  })
})
