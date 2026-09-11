/**
 * Artifact inventory: what an attempt is allowed to upload, and what "verified"
 * actually means.
 *
 * Two problems this module exists to close, both of which produce a broken video
 * that looks fine in the database:
 *
 * 1. **A partial upload must not publish.** The agent uploads many objects; if
 *    three segments of the 720p rendition never landed, the master playlist
 *    still exists and the video still "completes". So completion is refused
 *    until every inventory item is verified present at its recorded size.
 * 2. **An agent must not choose its own destination.** Upload grants are issued
 *    per path, bounded to the attempt's prefix, and only for paths the agent
 *    itself registered. `authorizeArtifactPath` is the single place that rule
 *    lives, because a rule enforced in several places is a rule enforced in
 *    none of them.
 *
 * On checksums: multipart ETags are **not** content hashes — an object uploaded
 * in 8 MiB parts has a different ETag than the same bytes uploaded in 5 MiB
 * parts, and an ETag may carry a `-N` suffix. So the agent's own SHA-256 is
 * recorded and compared, and the object store is asked only for the size.
 */

import { sql, type SQL } from 'drizzle-orm'
import {
  normalizeRows,
  runAtomically,
  supportsAtomicBatch,
  type AtomicBatchExecutor,
  type AtomicExecutor,
} from './atomicWrite'

/** One expected artifact, as the agent reports it. */
export type ArtifactRecord = {
  path: string
  size: number
  checksum?: string | null
  role?: string | null
  contentType?: string | null
}

export type InventoryStatus = 'open' | 'registering' | 'verified' | 'failed' | 'superseded'

/**
 * Ceiling on one inventory.
 *
 * Raised from 5,000 because that was not a ceiling anyone would hit *last* — it
 * is what a normal lecture reaches. A two-hour 1080p ladder at 4-second segments
 * is roughly 1,800 segments per rendition across five streams: about 9,000
 * objects. A limit below the common case is a limit that breaks the common case.
 * Registration and verification are paged (`MAX_INVENTORY_PAGE`), so the cap is
 * now a sanity bound rather than a working limit.
 */
export const MAX_INVENTORY_ITEMS = 50_000
/** Artifacts accepted in one registration request. */
export const MAX_INVENTORY_PAGE = 1_000
/** Objects verified per verify request, so no single call is unbounded. */
export const VERIFY_BATCH_SIZE = 250
/** Presigned URLs are issued in bounded batches, and renew only while authorized. */
export const GRANT_BATCH_SIZE = 250
/** HEAD requests issued concurrently within one verify call. */
const VERIFY_CONCURRENCY = 25

export type PathAuthorization =
  | { allowed: true; relative: string }
  | { allowed: false; reason: string }

/**
 * Normalize an artifact path to a prefix-relative one, or refuse it.
 *
 * Pure, and the security boundary. The checks are deliberately redundant with
 * the agent's own path policy: the agent is remote code, and "the client
 * validates it" is not a security argument.
 */
export function normalizeArtifactPath(candidate: unknown): PathAuthorization {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { allowed: false, reason: 'empty path' }
  }
  if (candidate.length > 1024) {
    return { allowed: false, reason: 'path too long' }
  }
  if (candidate.includes('\0')) {
    return { allowed: false, reason: 'path contains a NUL byte' }
  }
  // Backslashes are not separators in object keys, but accepting them lets a
  // Windows-built agent produce keys that no other reader resolves the same way.
  if (candidate.includes('\\')) {
    return { allowed: false, reason: 'backslash in path' }
  }
  if (candidate.startsWith('/')) {
    return { allowed: false, reason: 'absolute path' }
  }

  const segments = candidate.split('/')
  const cleaned: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      return { allowed: false, reason: 'path traversal' }
    }
    cleaned.push(segment)
  }
  if (cleaned.length === 0) {
    return { allowed: false, reason: 'empty path' }
  }
  return { allowed: true, relative: cleaned.join('/') }
}

/**
 * Is this path inside the attempt prefix *and* on the inventory?
 *
 * Both halves matter. Prefix containment alone would let an agent overwrite a
 * different video's attempt; inventory membership alone would let it write to an
 * arbitrary key if a path were ever smuggled into the list.
 */
export function authorizeArtifactPath(
  prefix: string,
  inventoryPaths: ReadonlySet<string>,
  candidate: unknown,
): PathAuthorization {
  const normalized = normalizeArtifactPath(candidate)
  if (!normalized.allowed) return normalized

  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '')
  if (!cleanPrefix) {
    return { allowed: false, reason: 'attempt prefix is not configured' }
  }
  if (!inventoryPaths.has(normalized.relative)) {
    return { allowed: false, reason: 'path is not in this attempt’s inventory' }
  }

  // The key the grant is signed for, checked against the prefix for containment
  // on a segment boundary so `videos/abc/attempts/att1x` cannot pass as a
  // prefix match for `videos/abc/attempts/att1`.
  const key = `${cleanPrefix}/${normalized.relative}`
  if (!key.startsWith(`${cleanPrefix}/`)) {
    return { allowed: false, reason: 'path escapes the attempt prefix' }
  }
  return { allowed: true, relative: normalized.relative }
}

export function artifactKey(prefix: string, relativePath: string): string {
  return `${prefix.replace(/^\/+|\/+$/g, '')}/${relativePath.replace(/^\/+/, '')}`
}

/**
 * Deterministic inventory fingerprint.
 *
 * Bound to the job so a re-registration with the same content is recognised as a
 * retry rather than treated as a conflicting second inventory.
 */
export function inventoryFingerprint(artifacts: ArtifactRecord[]): string {
  const material = artifacts
    .map((artifact) => `${artifact.path}:${artifact.size}:${artifact.checksum ?? ''}`)
    .sort()
    .join('\n')
  let hash = 0
  for (let i = 0; i < material.length; i += 1) {
    hash = (hash * 31 + material.charCodeAt(i)) | 0
  }
  return `inv_${(hash >>> 0).toString(16)}`
}

export type RegisterInventoryInput = {
  videoId: string
  organizationId: string
  jobId: string | null
  attemptId: string
  prefix: string
  artifacts: ArtifactRecord[]
  /**
   * `replace` (default) restates the whole plan; `append` adds a page to it.
   *
   * A resumed attempt re-reports everything it intends to upload, so the first
   * page replaces any stale plan. Subsequent pages append — without this, a
   * 9,000-object inventory is either impossible to register or every page wipes
   * the one before it.
   */
  mode?: 'replace' | 'append'
}

/**
 * Register (or re-register) the inventory for one attempt.
 *
 * Written as one statement so the header and its items cannot disagree: an
 * inventory claiming `item_count = 40` with 12 rows would make verification
 * unsolvable. Re-registration for the same attempt replaces the item set — a
 * resumed attempt re-reports everything it plans to upload, and stale rows from
 * an earlier plan must not stay behind to block verification.
 */
/**
 * Write an inventory's items. The header counts are computed separately.
 *
 * Two statements rather than one, for the same reason verification is split: a
 * data-modifying CTE's changes are invisible to the rest of its own statement.
 * A single-statement version therefore could not see the inventory row it had
 * just inserted, so the header `UPDATE` matched nothing on a first registration
 * and callers received an empty result — which surfaced as a uuid parse error
 * one layer up. Reproduced against PostgreSQL 18.
 */
export function buildRegisterInventoryItemsStatement(input: RegisterInventoryInput): SQL {
  const items = input.artifacts.map((artifact) => {
    const normalized = normalizeArtifactPath(artifact.path)
    if (!normalized.allowed) {
      throw new Error(`invalid artifact path: ${normalized.reason}`)
    }
    return {
      path: normalized.relative,
      size: Math.max(0, Math.floor(artifact.size)),
      checksum: artifact.checksum ?? null,
      role: artifact.role ?? 'segment',
    }
  })

  if (items.length === 0) {
    throw new Error('inventory must contain at least one artifact')
  }
  if (items.length > MAX_INVENTORY_ITEMS) {
    throw new Error(`inventory exceeds ${MAX_INVENTORY_ITEMS} artifacts`)
  }

  const values = sql.join(
    items.map(
      (item) =>
        sql`(${item.path}::text, ${item.size}::bigint, ${item.checksum}::text, ${item.role}::text)`,
    ),
    sql`, `,
  )
  const replace = (input.mode ?? 'replace') === 'replace'

  return sql`
    WITH upserted AS (
      INSERT INTO artifact_inventory (
        video_id, organization_id, job_id, attempt_id, prefix, status,
        item_count, verified_count
      )
      VALUES (
        ${input.videoId}::uuid, ${input.organizationId}, ${input.jobId}::uuid,
        ${input.attemptId}, ${input.prefix}, 'registering',
        0, 0
      )
      ON CONFLICT (attempt_id) DO UPDATE
        SET prefix = EXCLUDED.prefix,
            status = CASE
              WHEN artifact_inventory.status = 'superseded' THEN 'superseded'
              ELSE 'registering'
            END,
            job_id = COALESCE(EXCLUDED.job_id, artifact_inventory.job_id),
            verified_at = NULL,
            last_error = NULL,
            updated_at = now()
      RETURNING id
    ),
    cleared AS (
      DELETE FROM artifact_inventory_item
      WHERE inventory_id IN (SELECT id FROM upserted)
        AND ${replace}::boolean
      RETURNING id
    ),
    inserted AS (
      INSERT INTO artifact_inventory_item (inventory_id, path, size_bytes, checksum, role)
      SELECT (SELECT id FROM upserted), v.path, v.size, v.checksum, v.role
      FROM (VALUES ${values}) AS v(path, size, checksum, role)
      ON CONFLICT (inventory_id, path) DO UPDATE
        SET size_bytes = EXCLUDED.size_bytes,
            checksum = COALESCE(EXCLUDED.checksum, artifact_inventory_item.checksum),
            role = EXCLUDED.role
      RETURNING id
    )
    SELECT (SELECT id FROM upserted) AS id, (SELECT count(*) FROM inserted)::int AS inserted
  `
}

/**
 * Recompute an inventory's header from its items.
 *
 * `verified_count` is derived, never incremented, so a paged registration or a
 * retried batch cannot inflate it. A `superseded` inventory stays superseded:
 * losing that mark would silently re-authorize an abandoned attempt's grants.
 */
export function buildRecomputeInventoryHeaderStatement(input: { inventoryId: string }): SQL {
  return sql`
    UPDATE artifact_inventory AS inv
    SET item_count = recount.total,
        verified_count = recount.verified,
        status = CASE
          WHEN inv.status = 'superseded' THEN 'superseded'
          WHEN recount.total > 0 AND recount.verified = recount.total THEN 'verified'
          WHEN recount.failed > 0 THEN 'failed'
          ELSE 'registering'
        END,
        verified_at = CASE
          WHEN inv.status <> 'superseded'
            AND recount.total > 0
            AND recount.verified = recount.total
            THEN now()
          ELSE NULL
        END,
        updated_at = now()
    FROM (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'verified')::int AS verified,
        count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM artifact_inventory_item
      WHERE inventory_id = ${input.inventoryId}::uuid
    ) AS recount
    WHERE inv.id = ${input.inventoryId}::uuid
    RETURNING inv.id, inv.item_count, inv.verified_count, inv.status
  `
}

export async function registerInventory(
  executor: AtomicExecutor,
  input: RegisterInventoryInput,
): Promise<{ inventoryId: string; items: number; status: string }> {
  const atomic = executor as AtomicExecutor & AtomicBatchExecutor
  if (!supportsAtomicBatch(atomic)) {
    throw new Error('inventory registration requires a driver with batch() or transaction()')
  }

  const results = await runAtomically(atomic, (handle) => {
    const scoped = handle as unknown as AtomicExecutor
    return [scoped.execute(buildRegisterInventoryItemsStatement(input))]
  })

  const written = normalizeRows(results[results.length - 1])[0]
  const inventoryId = written ? String(written.id) : ''
  if (!inventoryId) {
    throw new Error('inventory registration returned no id')
  }

  // Second statement, so the header sees the rows the first one wrote.
  const header = normalizeRows(
    await executor.execute(buildRecomputeInventoryHeaderStatement({ inventoryId })),
  )[0]

  return {
    inventoryId,
    items: Number(header?.item_count ?? written?.inserted ?? 0),
    status: String(header?.status ?? 'registering'),
  }
}

/**
 * Register a whole artifact set in bounded pages.
 *
 * The first page replaces (clearing any stale plan from an earlier attempt) and
 * the rest append. Sequential rather than concurrent: the page order decides
 * which write wins a path, and a race between "replace" and "append" would make
 * the resulting inventory depend on timing.
 */
export async function registerInventoryPaged(
  executor: AtomicExecutor,
  input: Omit<RegisterInventoryInput, 'mode'>,
  pageSize = MAX_INVENTORY_PAGE,
): Promise<{ inventoryId: string; items: number; status: string }> {
  const pages = batchArtifacts(input.artifacts, Math.min(pageSize, MAX_INVENTORY_PAGE))
  if (pages.length === 0) {
    throw new Error('inventory must contain at least one artifact')
  }
  let result = { inventoryId: '', items: 0, status: 'registering' }
  for (const [index, page] of pages.entries()) {
    result = await registerInventory(executor, {
      ...input,
      artifacts: page,
      mode: index === 0 ? 'replace' : 'append',
    })
  }
  return result
}

/**
 * Mark a batch of paths as uploaded by the agent.
 *
 * This is the agent's *claim*, not the API's verification — see
 * `verifyInventory`. Only rows already in the inventory are touched, so a path
 * the agent invented is silently ignored here and refused at grant time.
 */
export function buildMarkUploadedStatement(input: {
  inventoryId: string
  paths: string[]
  checksums?: Record<string, string>
}): SQL {
  const cleaned = input.paths
    .map((path) => normalizeArtifactPath(path))
    .filter((result): result is { allowed: true; relative: string } => result.allowed)
    .map((result) => result.relative)

  if (cleaned.length === 0) {
    return sql`SELECT 0::int AS updated`
  }

  // One VALUES list carrying both the path and (optionally) the checksum the
  // agent reported. A `LEFT JOIN ... ON TRUE` would multiply rows by the size of
  // the checksum list, which is how a batch of 200 uploads silently becomes
  // 40,000 updates.
  const checksums = input.checksums ?? {}
  const rows = cleaned.map((path) => {
    const normalizedChecksum =
      typeof checksums[path] === 'string' && checksums[path].length > 0
        ? checksums[path].slice(0, 128)
        : null
    return sql`(${path}, ${normalizedChecksum})`
  })
  const values = sql.join(rows, sql`, `)

  return sql`
    WITH targets AS (
      SELECT item.id, v.checksum
      FROM artifact_inventory_item AS item
      JOIN (VALUES ${values}) AS v(path, checksum) ON v.path = item.path
      WHERE item.inventory_id = ${input.inventoryId}::uuid
        AND item.status IN ('pending', 'failed')
    ),
    updated AS (
      UPDATE artifact_inventory_item AS item
      SET status = 'uploaded',
          uploaded_at = now(),
          attempts = item.attempts + 1,
          error = NULL,
          checksum = COALESCE(t.checksum, item.checksum)
      FROM targets AS t
      WHERE item.id = t.id
      RETURNING item.id
    )
    SELECT count(*)::int AS updated FROM updated
  `
}

export async function markArtifactsUploaded(
  executor: AtomicExecutor,
  input: { inventoryId: string; paths: string[]; checksums?: Record<string, string> },
): Promise<number> {
  const rows = normalizeRows(await executor.execute(buildMarkUploadedStatement(input)))
  return Number(rows[0]?.updated ?? 0)
}

/** Rows still needing an upload grant: everything not yet verified. */
export function buildPendingArtifactsStatement(input: {
  inventoryId: string
  attemptId: string
  limit?: number
}): SQL {
  const limit = Math.min(input.limit ?? GRANT_BATCH_SIZE, MAX_INVENTORY_ITEMS)
  return sql`
    SELECT item.path, item.size_bytes AS "sizeBytes", item.checksum, item.role
    FROM artifact_inventory_item AS item
    JOIN artifact_inventory AS inv ON inv.id = item.inventory_id
    WHERE item.inventory_id = ${input.inventoryId}::uuid
      AND inv.attempt_id = ${input.attemptId}
      AND inv.status <> 'superseded'
      AND item.status <> 'verified'
    ORDER BY (item.role IN ('playlist', 'dash')) ASC, item.path ASC
    LIMIT ${limit}::int
  `
}

/**
 * Order for upload: segments first, playlists last.
 *
 * The SQL mirrors `order_for_publication` in the engine. It is duplicated as an
 * `ORDER BY` rather than computed in JS because the grant call is paged — a
 * caller that sorted only page one would publish a playlist before the segments
 * it names.
 */
export async function readPendingArtifacts(
  executor: AtomicExecutor,
  input: { inventoryId: string; attemptId: string; limit?: number },
): Promise<Array<{ path: string; sizeBytes: number; checksum: string | null; role: string }>> {
  const rows = normalizeRows(await executor.execute(buildPendingArtifactsStatement(input)))
  return rows.map((row) => ({
    path: String(row.path),
    sizeBytes: Number(row.sizeBytes ?? 0),
    checksum: row.checksum ? String(row.checksum) : null,
    role: row.role ? String(row.role) : 'segment',
  }))
}

export function buildInventoryArtifactsStatement(input: { inventoryId: string }): SQL {
  return sql`
    SELECT path, size_bytes AS "sizeBytes", checksum, role, status
    FROM artifact_inventory_item
    WHERE inventory_id = ${input.inventoryId}::uuid
    ORDER BY path ASC
  `
}

export async function readInventoryArtifacts(
  executor: AtomicExecutor,
  input: { inventoryId: string },
): Promise<Array<{ path: string; sizeBytes: number; checksum: string | null; role: string; status: string }>> {
  const rows = normalizeRows(await executor.execute(buildInventoryArtifactsStatement(input)))
  return rows.map((row) => ({
    path: String(row.path),
    sizeBytes: Number(row.sizeBytes ?? 0),
    checksum: row.checksum ? String(row.checksum) : null,
    role: String(row.role ?? 'segment'),
    status: String(row.status ?? 'pending'),
  }))
}

export type VerifyOutcome = {
  path: string
  ok: boolean
  reason?: string
}

/**
 * Apply verification results, then flip the inventory to `verified` only when
 * every item passed.
 *
 * The `verified_count` is recomputed from the item table rather than
 * incremented, so a retried verification of the same batch cannot inflate it and
 * a re-upload after a mismatch cannot leave a stale count behind.
 */
/**
 * Items still awaiting verification, bounded.
 *
 * Bounded because a 9,000-object inventory cannot be HEADed in one request: a
 * Worker would exceed its subrequest and CPU budgets and time out, leaving an
 * inventory that is neither verified nor failed. `FAILED` items are included so
 * a re-upload that has since landed is re-checked rather than stuck.
 */
export function buildVerificationCandidatesStatement(input: {
  inventoryId: string
  limit?: number
}): SQL {
  const limit = Math.min(input.limit ?? VERIFY_BATCH_SIZE, MAX_INVENTORY_ITEMS)
  return sql`
    SELECT path, size_bytes AS "sizeBytes"
    FROM artifact_inventory_item
    WHERE inventory_id = ${input.inventoryId}::uuid
      AND status <> 'verified'
    ORDER BY path ASC
    LIMIT ${limit}::int
  `
}

export async function readVerificationCandidates(
  executor: AtomicExecutor,
  input: { inventoryId: string; limit?: number },
): Promise<Array<{ path: string; sizeBytes: number }>> {
  const rows = normalizeRows(await executor.execute(buildVerificationCandidatesStatement(input)))
  return rows.map((row) => ({
    path: String(row.path),
    sizeBytes: Number(row.sizeBytes ?? 0),
  }))
}

export function buildRemainingCountStatement(input: { inventoryId: string }): SQL {
  return sql`
    SELECT count(*) FILTER (WHERE status <> 'verified')::int AS remaining
    FROM artifact_inventory_item
    WHERE inventory_id = ${input.inventoryId}::uuid
  `
}

export async function readRemainingCount(
  executor: AtomicExecutor,
  input: { inventoryId: string },
): Promise<number> {
  const rows = normalizeRows(await executor.execute(buildRemainingCountStatement(input)))
  return Number(rows[0]?.remaining ?? 0)
}

/** Verify concurrency, so a single call does not open thousands of sockets. */
export function verificationConcurrency(): number {
  return VERIFY_CONCURRENCY
}

/**
 * Apply one verification batch: the items, then the header counts.
 *
 * **Two ordered statements in one transaction**, not one statement, and the
 * reason is a PostgreSQL semantics problem rather than a style preference:
 *
 * A data-modifying CTE's changes are invisible to the rest of the statement that
 * makes them. The obvious single-statement shape — update the items in a CTE,
 * then recompute the header from the item table — therefore counts the *old*
 * rows and reports zero verified artifacts. The agent, having made exactly one
 * verification call, treats that as failure and abandons a job whose bytes are
 * all present. Reproduced against PostgreSQL 18.
 *
 * A second statement in the same transaction gets a fresh snapshot, so it sees
 * the first statement's committed-in-transaction effects. `runAtomically` makes
 * the pair all-or-nothing, so a crash between them cannot leave a header that
 * disagrees with its items.
 */

/** The item-level write. One row per path, outcome supplied by the caller. */
export function buildApplyVerificationItemsStatement(input: {
  inventoryId: string
  verified: string[]
  failed: Array<{ path: string; reason: string }>
}): SQL {
  const rows: SQL[] = []
  for (const path of input.verified) {
    const normalized = normalizeArtifactPath(path)
    if (normalized.allowed) {
      rows.push(sql`(${normalized.relative}::text, 'verified'::text, NULL::text)`)
    }
  }
  for (const entry of input.failed) {
    const normalized = normalizeArtifactPath(entry.path)
    if (normalized.allowed) {
      rows.push(
        sql`(${normalized.relative}::text, 'failed'::text, ${entry.reason.slice(0, 500)}::text)`,
      )
    }
  }

  if (rows.length === 0) {
    return sql`SELECT 0::int AS updated`
  }

  // `sql.join` produces the complete `(VALUES ...)` expression and is used
  // directly as a relation. Wrapping it again rendered
  // `FROM (VALUES (VALUES (...)))`, which PostgreSQL rejects outright — so every
  // verification request failed, including a single-artifact success.
  return sql`
    WITH outcomes AS (
      SELECT * FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(path, outcome, reason)
    ),
    applied AS (
      UPDATE artifact_inventory_item AS item
      SET status = o.outcome,
          error = o.reason,
          verified_at = CASE WHEN o.outcome = 'verified' THEN now() ELSE NULL END,
          attempts = item.attempts + 1
      FROM outcomes AS o
      WHERE item.inventory_id = ${input.inventoryId}::uuid
        AND item.path = o.path
      RETURNING item.id
    )
    SELECT count(*)::int AS updated FROM applied
  `
}

/**
 * The header recompute. Runs *after* the item write, so it reads the new state.
 *
 * `verified_count` is recomputed from the table rather than incremented, so a
 * retried batch cannot inflate it and a re-upload after a mismatch cannot leave
 * a stale count behind.
 */
export function buildApplyVerificationHeaderStatement(input: { inventoryId: string }): SQL {
  return sql`
    WITH recount AS (
      SELECT
        count(*) FILTER (WHERE status = 'verified')::int AS verified,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM artifact_inventory_item
      WHERE inventory_id = ${input.inventoryId}::uuid
    )
    UPDATE artifact_inventory AS inv
    SET verified_count = recount.verified,
        status = CASE
          WHEN recount.total > 0 AND recount.verified = recount.total THEN 'verified'
          WHEN recount.failed > 0 THEN 'failed'
          ELSE 'registering'
        END,
        verified_at = CASE
          WHEN recount.total > 0 AND recount.verified = recount.total THEN now()
          ELSE NULL
        END,
        last_error = CASE
          WHEN recount.failed > 0
            THEN recount.failed::text || ' artifact(s) failed verification'
          ELSE NULL
        END,
        updated_at = now()
    FROM recount
    WHERE inv.id = ${input.inventoryId}::uuid
    RETURNING inv.id, inv.status, inv.verified_count, inv.item_count
  `
}

export type InventoryVerification = {
  inventoryId: string
  status: InventoryStatus
  verified: number
  total: number
}

export async function applyVerification(
  executor: AtomicExecutor,
  input: {
    inventoryId: string
    verified: string[]
    failed: Array<{ path: string; reason: string }>
  },
): Promise<InventoryVerification | null> {
  // Items first, then the header, in one transaction — see the note above on why
  // this cannot be a single statement.
  const atomic = executor as AtomicExecutor & AtomicBatchExecutor
  if (!supportsAtomicBatch(atomic)) {
    throw new Error('verification requires a driver with batch() or transaction()')
  }

  const results = await runAtomically(atomic, (handle) => {
    const scoped = handle as unknown as AtomicExecutor
    return [
      scoped.execute(buildApplyVerificationItemsStatement(input)),
      scoped.execute(buildApplyVerificationHeaderStatement(input)),
    ]
  })

  const rows = normalizeRows(results[results.length - 1])
  const row = rows[0]
  if (!row) return null
  return {
    inventoryId: String(row.id),
    status: String(row.status) as InventoryStatus,
    verified: Number(row.verified_count ?? 0),
    total: Number(row.item_count ?? 0),
  }
}

/**
 * Split verification work into bounded batches.
 *
 * Bounded because a 4K ladder can be several thousand objects: one unbounded
 * HEAD loop would exceed a Worker's CPU budget and time out, leaving an
 * inventory that is neither verified nor failed.
 */
export function batchArtifacts<T>(artifacts: T[], size = GRANT_BATCH_SIZE): T[][] {
  if (size <= 0) throw new Error('batch size must be positive')
  const batches: T[][] = []
  for (let i = 0; i < artifacts.length; i += size) {
    batches.push(artifacts.slice(i, i + size))
  }
  return batches
}

/**
 * Decide whether a set of remote HEAD results verifies an inventory.
 *
 * Pure, so the "size mismatch is a failure, missing object is a failure, a
 * matching size passes" rules are checked with literals. Checksum comparison is
 * intentionally *not* done here: the object store is not asked for a content
 * hash, because the only hash it can give back is not one.
 */
export function classifyVerification(
  expected: Array<{ path: string; sizeBytes: number }>,
  observed: Map<string, number | null>,
): { verified: string[]; failed: Array<{ path: string; reason: string }> } {
  const verified: string[] = []
  const failed: Array<{ path: string; reason: string }> = []
  for (const artifact of expected) {
    const actual = observed.get(artifact.path)
    if (actual === null || actual === undefined) {
      failed.push({ path: artifact.path, reason: 'object is missing' })
      continue
    }
    if (actual !== artifact.sizeBytes) {
      failed.push({
        path: artifact.path,
        reason: `size mismatch: expected ${artifact.sizeBytes}, found ${actual}`,
      })
      continue
    }
    verified.push(artifact.path)
  }
  return { verified, failed }
}

/**
 * Prefix an attempt's live bytes are published under.
 *
 * Read from the inventory (which recorded what was actually uploaded to) rather
 * than recomputed, so a later change to the prefix scheme cannot repoint an
 * already-uploaded attempt at a key nothing was written to.
 */
export function buildPublishedPrefixStatement(input: {
  videoId: string
  attemptId: string
}): SQL {
  return sql`
    SELECT prefix, status, verified_count, item_count
    FROM artifact_inventory
    WHERE video_id = ${input.videoId}::uuid
      AND attempt_id = ${input.attemptId}
    LIMIT 1
  `
}

export async function readInventoryForAttempt(
  executor: AtomicExecutor,
  input: { videoId: string; attemptId: string },
): Promise<{
  prefix: string
  status: InventoryStatus
  verified: number
  total: number
} | null> {
  const rows = normalizeRows(await executor.execute(buildPublishedPrefixStatement(input)))
  const row = rows[0]
  if (!row) return null
  return {
    prefix: String(row.prefix),
    status: String(row.status) as InventoryStatus,
    verified: Number(row.verified_count ?? 0),
    total: Number(row.item_count ?? 0),
  }
}

/**
 * Retire an attempt's inventory so its grants stop being renewable.
 *
 * Without this a superseded attempt keeps a *renewable* grant: the old
 * inventory is still authorized, so the agent that no longer owns the job can
 * keep uploading into a prefix the newer attempt may already be publishing.
 * Called on retry, cancel and lease reclaim — every path that ends ownership.
 */
export function buildSupersedeInventoryStatement(input: {
  videoId: string
  /** The attempt to keep, or null to retire every attempt for the video. */
  exceptAttemptId: string | null
}): SQL {
  const keep = input.exceptAttemptId
  if (keep === null) {
    return sql`
      UPDATE artifact_inventory
      SET status = 'superseded', updated_at = now()
      WHERE video_id = ${input.videoId}::uuid
        AND status <> 'superseded'
      RETURNING id
    `
  }
  return sql`
    UPDATE artifact_inventory
    SET status = 'superseded', updated_at = now()
    WHERE video_id = ${input.videoId}::uuid
      AND attempt_id <> ${keep}
      AND status <> 'superseded'
    RETURNING id
  `
}

export async function supersedeInventories(
  executor: AtomicExecutor,
  input: { videoId: string; exceptAttemptId: string | null },
): Promise<number> {
  const rows = normalizeRows(await executor.execute(buildSupersedeInventoryStatement(input)))
  return rows.length
}
