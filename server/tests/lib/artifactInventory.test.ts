import { describe, expect, it } from 'vitest'
import {
  GRANT_BATCH_SIZE,
  artifactKey,
  authorizeArtifactPath,
  batchArtifacts,
  buildApplyVerificationHeaderStatement,
  buildApplyVerificationItemsStatement,
  buildPendingArtifactsStatement,
  buildRecomputeInventoryHeaderStatement,
  buildRegisterInventoryItemsStatement,
  classifyVerification,
  inventoryFingerprint,
  normalizeArtifactPath,
} from '../../src/lib/artifactInventory'
import { containsClause, sqlText } from '../helpers/sql'

const PREFIX = 'videos/vid-1/attempts/att-1'

describe('normalizeArtifactPath', () => {
  it('accepts a plain relative path', () => {
    expect(normalizeArtifactPath('video_1080p/init.mp4')).toEqual({
      allowed: true,
      relative: 'video_1080p/init.mp4',
    })
  })

  it('collapses redundant separators and dot segments', () => {
    expect(normalizeArtifactPath('./video_720p//1.m4s')).toEqual({
      allowed: true,
      relative: 'video_720p/1.m4s',
    })
  })

  it('refuses traversal', () => {
    expect(normalizeArtifactPath('../../etc/passwd')).toMatchObject({
      allowed: false,
      reason: 'path traversal',
    })
  })

  it('refuses an absolute path', () => {
    expect(normalizeArtifactPath('/etc/passwd')).toMatchObject({ allowed: false })
  })

  it('refuses backslashes so a Windows agent cannot invent a key layout', () => {
    expect(normalizeArtifactPath('video_720p\\init.mp4')).toMatchObject({
      allowed: false,
      reason: 'backslash in path',
    })
  })

  it('refuses a NUL byte', () => {
    expect(normalizeArtifactPath('a\u0000b.mp4')).toMatchObject({ allowed: false })
  })

  it('refuses empty and non-string input', () => {
    expect(normalizeArtifactPath('').allowed).toBe(false)
    expect(normalizeArtifactPath(null).allowed).toBe(false)
    expect(normalizeArtifactPath(42).allowed).toBe(false)
  })

  it('refuses an absurdly long path', () => {
    expect(normalizeArtifactPath('a'.repeat(2000)).allowed).toBe(false)
  })
})

describe('authorizeArtifactPath', () => {
  const inventory = new Set(['playlist.m3u8', 'video_1080p/init.mp4'])

  it('allows an inventory-listed path', () => {
    expect(authorizeArtifactPath(PREFIX, inventory, 'video_1080p/init.mp4')).toEqual({
      allowed: true,
      relative: 'video_1080p/init.mp4',
    })
  })

  it('refuses a path that is not in the inventory', () => {
    // Even inside the prefix: an agent may only write what it declared.
    expect(authorizeArtifactPath(PREFIX, inventory, 'video_1080p/9.m4s')).toMatchObject({
      allowed: false,
      reason: 'path is not in this attempt’s inventory',
    })
  })

  it('refuses to act at all with no attempt prefix', () => {
    expect(authorizeArtifactPath('', inventory, 'playlist.m3u8')).toMatchObject({
      allowed: false,
      reason: 'attempt prefix is not configured',
    })
  })

  it('keeps every authorized key inside this attempt’s own prefix', () => {
    // Even a relative path that spells out a sibling attempt resolves to a key
    // under *our* prefix, because the prefix is prepended, not pattern-matched.
    const sneaky = 'videos/vid-1/attempts/att-1x/playlist.m3u8'
    const result = authorizeArtifactPath(PREFIX, new Set([sneaky]), sneaky)
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(artifactKey(PREFIX, result.relative).startsWith(`${PREFIX}/`)).toBe(true)
      expect(artifactKey(PREFIX, result.relative)).toBe(`${PREFIX}/${sneaky}`)
    }
  })

  it('never lets a path with traversal reach the inventory check', () => {
    expect(
      authorizeArtifactPath(PREFIX, new Set(['playlist.m3u8']), '../playlist.m3u8'),
    ).toMatchObject({ allowed: false, reason: 'path traversal' })
  })
})

describe('artifactKey', () => {
  it('joins prefix and path without doubling slashes', () => {
    expect(artifactKey('/videos/v/a/', '/playlist.m3u8')).toBe('videos/v/a/playlist.m3u8')
  })
})

describe('inventoryFingerprint', () => {
  it('is order-independent', () => {
    const a = [{ path: 'a', size: 1 }, { path: 'b', size: 2 }]
    const b = [{ path: 'b', size: 2 }, { path: 'a', size: 1 }]
    expect(inventoryFingerprint(a)).toBe(inventoryFingerprint(b))
  })

  it('changes when a size changes', () => {
    expect(inventoryFingerprint([{ path: 'a', size: 1 }])).not.toBe(
      inventoryFingerprint([{ path: 'a', size: 2 }]),
    )
  })
})

describe('register statement', () => {
  const statement = buildRegisterInventoryItemsStatement({
    videoId: 'vid-1',
    organizationId: 'org-1',
    jobId: 'job-1',
    attemptId: 'att-1',
    prefix: PREFIX,
    artifacts: [
      { path: 'playlist.m3u8', size: 100, role: 'playlist' },
      { path: 'video_1080p/init.mp4', size: 200, role: 'segment' },
    ],
  })

  it('is keyed on the attempt so a retry gets its own inventory', () => {
    expect(containsClause(statement, 'ON CONFLICT (attempt_id)')).toBe(true)
  })

  it('replaces the item set on re-registration rather than merging', () => {
    // A resumed attempt re-reports its whole plan; stale rows would block
    // verification forever.
    expect(containsClause(statement, 'DELETE FROM artifact_inventory_item')).toBe(true)
  })

  it('derives the item count from the rows it wrote, not from a stale snapshot', () => {
    // The header counts are recomputed by a second statement; a data-modifying
    // CTE's inserts are invisible to the rest of its own statement, so doing it
    // inline produced a header that claimed zero items and a first-registration
    // result with no id at all.
    expect(sqlText(statement)).toContain('FROM inserted')
    expect(sqlText(buildRecomputeInventoryHeaderStatement({ inventoryId: 'x' }))).toContain(
      'FROM artifact_inventory_item',
    )
  })

  it('refuses traversal in a declared artifact path', () => {
    expect(() =>
      buildRegisterInventoryItemsStatement({
        videoId: 'vid-1',
        organizationId: 'org-1',
        jobId: null,
        attemptId: 'att-1',
        prefix: PREFIX,
        artifacts: [{ path: '../../evil', size: 1 }],
      }),
    ).toThrow(/invalid artifact path/)
  })

  it('refuses an empty inventory', () => {
    expect(() =>
      buildRegisterInventoryItemsStatement({
        videoId: 'vid-1',
        organizationId: 'org-1',
        jobId: null,
        attemptId: 'att-1',
        prefix: PREFIX,
        artifacts: [],
      }),
    ).toThrow(/at least one artifact/)
  })
})

describe('pending-artifacts statement', () => {
  const statement = buildPendingArtifactsStatement({
    inventoryId: '11111111-1111-1111-1111-111111111111',
    attemptId: 'att-1',
  })

  it('publishes playlists last', () => {
    // Sorted in SQL, not in JS: the call is paged, and sorting page one only
    // would let a playlist be uploaded before the segments it names.
    expect(sqlText(statement)).toMatch(/ORDER BY .*playlist.*ASC, item\.path ASC/)
  })

  it('never issues a grant for an already-verified artifact', () => {
    expect(containsClause(statement, "item.status <> 'verified'")).toBe(true)
  })

  it('stops issuing grants once the attempt is superseded', () => {
    expect(containsClause(statement, "inv.status <> 'superseded'")).toBe(true)
  })

  it('is bounded by a batch limit', () => {
    expect(sqlText(statement)).toContain('LIMIT')
  })
})

describe('verification statement', () => {
  const statement = buildApplyVerificationItemsStatement({
    inventoryId: '11111111-1111-1111-1111-111111111111',
    verified: ['playlist.m3u8'],
    failed: [{ path: 'video_720p/1.m4s', reason: 'object is missing' }],
  })

  it('recomputes the verified count from the item table rather than incrementing it', () => {
    // Incrementing lets a retried verification inflate the count and publish a
    // package with holes in it. The count must also be computed in a *separate*
    // statement: a data-modifying CTE cannot see its own updates, so an inline
    // recount reported zero verified items and the agent abandoned the job.
    const header = sqlText(buildApplyVerificationHeaderStatement({ inventoryId: 'x' }))
    expect(header).toContain("count(*) FILTER (WHERE status = 'verified')")
    expect(header).toContain('verified_count = recount.verified')
    expect(header).toContain('FROM artifact_inventory_item')
  })

  it('only flips to verified when every item passed', () => {
    const header = buildApplyVerificationHeaderStatement({ inventoryId: 'x' })
    expect(containsClause(header, 'recount.verified = recount.total')).toBe(true)
  })

  it('records the failure reason on the item', () => {
    expect(containsClause(statement, 'error = o.reason')).toBe(true)
  })

  it('does not wrap a VALUES expression inside another VALUES', () => {
    // `FROM (VALUES (VALUES (...)))` is rejected by PostgreSQL outright, so every
    // verification request failed — including a single-artifact success.
    expect(sqlText(statement)).toContain('SELECT * FROM (VALUES')
    expect(sqlText(statement)).not.toContain('FROM (VALUES (VALUES')
  })
})

describe('batchArtifacts', () => {
  it('splits into bounded batches', () => {
    const items = Array.from({ length: 7 }, (_, i) => i)
    expect(batchArtifacts(items, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]])
  })

  it('returns nothing for an empty list', () => {
    expect(batchArtifacts([], 10)).toEqual([])
  })

  it('keeps the default batch inside the grant limit', () => {
    expect(GRANT_BATCH_SIZE).toBeGreaterThan(0)
    expect(GRANT_BATCH_SIZE).toBeLessThanOrEqual(1000)
  })

  it('refuses a non-positive batch size', () => {
    expect(() => batchArtifacts([1], 0)).toThrow(/positive/)
  })
})

describe('classifyVerification', () => {
  const expected = [
    { path: 'playlist.m3u8', sizeBytes: 100 },
    { path: 'video_720p/init.mp4', sizeBytes: 200 },
    { path: 'video_720p/1.m4s', sizeBytes: 300 },
  ]

  it('verifies an artifact whose size matches', () => {
    const result = classifyVerification(expected, new Map([
      ['playlist.m3u8', 100],
      ['video_720p/init.mp4', 200],
      ['video_720p/1.m4s', 300],
    ]))
    expect(result.verified).toEqual(['playlist.m3u8', 'video_720p/init.mp4', 'video_720p/1.m4s'])
    expect(result.failed).toEqual([])
  })

  it('fails a missing object', () => {
    const result = classifyVerification(expected, new Map([
      ['playlist.m3u8', 100],
      ['video_720p/init.mp4', null],
      ['video_720p/1.m4s', 300],
    ]))
    expect(result.failed).toEqual([
      { path: 'video_720p/init.mp4', reason: 'object is missing' },
    ])
    expect(result.verified).not.toContain('video_720p/init.mp4')
  })

  it('fails a size mismatch, with both numbers reported', () => {
    const result = classifyVerification(expected, new Map([
      ['playlist.m3u8', 100],
      ['video_720p/init.mp4', 200],
      ['video_720p/1.m4s', 299],
    ]))
    expect(result.failed).toEqual([
      { path: 'video_720p/1.m4s', reason: 'size mismatch: expected 300, found 299' },
    ])
  })

  it('fails an object that was never observed at all', () => {
    const result = classifyVerification(expected, new Map())
    expect(result.failed).toHaveLength(3)
    expect(result.verified).toEqual([])
  })
})
