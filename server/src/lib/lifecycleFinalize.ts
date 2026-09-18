/**
 * Video lifecycle finalization — the one place a transcode attempt ends.
 *
 * Why this module exists rather than two call sites:
 *
 * Modal reports completion over HTTP; a self-hosted agent reports it over the
 * agent protocol. Those are different transports carrying the same *event*, and
 * the rules for accepting that event are not transport-specific:
 *
 *   - late or duplicate callbacks must never resurrect `failed` or downgrade
 *     `ready` (the state machine in `videoState.ts`),
 *   - an attempt that no longer owns the row must not write its outputs
 *     (`decideAttemptOwnership` in `transcodeClaim.ts`),
 *   - the state change and its `video.ready`/`video.failed` outbox row must be
 *     **one** database operation, or a crash between them loses the event
 *     forever (`lifecycleOutbox.ts`),
 *   - usage accounting has to see the same numbers on both paths.
 *
 * Duplicating that is how the two providers drift: the local path quietly stops
 * enforcing attempt ownership, or stops writing `transcoded_size`, and nobody
 * notices until a tenant's bill is wrong. So both call *this*.
 *
 * Publication is additionally gated on the artifact inventory for self-hosted
 * attempts. The gate is part of the same guarded statement as the transition, so
 * "everything verified" and "mark it ready" cannot be separated by a crash. This
 * is atomic publication of the **application's playback reference** — not an
 * atomic multi-object object-store upload, which is not a thing that exists.
 */

import { sql, type SQL } from 'drizzle-orm'
import {
  normalizeRows,
  runAtomicIntent,
  runAtomically,
  supportsAtomicBatch,
  type AtomicBatchExecutor,
  type AtomicExecutor,
} from './atomicWrite'
import { newEventId } from './lifecycleOutbox'
import type { WebhookEvent } from '../utils/webhookDispatcher'

/** Attempt-scoped output prefix: `videos/<video-id>/attempts/<attempt-id>`. */
export function attemptPrefix(videoId: string, attemptId: string, prefix = 'videos'): string {
  return `${prefix.replace(/^\/+|\/+$/g, '')}/${videoId}/attempts/${attemptId}`
}

/** Legacy (Modal) output prefix: `videos/<video-id>`. */
export function legacyPrefix(videoId: string, prefix = 'videos'): string {
  return `${prefix.replace(/^\/+|\/+$/g, '')}/${videoId}`
}

export function joinUrl(base: string, path: string): string {
  const b = (base || '').replace(/\/+$/, '')
  const p = String(path || '').replace(/^\/+/, '')
  if (!b) return p
  return `${b}/${p}`
}

export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * Everything a completion payload can contribute to the video row.
 *
 * Kept as a pure function so the field-by-field mapping is checkable against
 * literals — this is the code that decides what a viewer's player is pointed at,
 * and it has to agree with the agent's `PipelineResult.as_payload()` exactly.
 */
export type ParsedCompletion = {
  hlsUrl: string | null
  thumbnailUrl: string | null
  subtitleUrl: string | null
  subtitleStatus: string | null
  chaptersStatus: string | null
  chapters: Array<{ startTime: number; endTime: number; title: string }> | null
  duration: number | null
  resolutions: string[] | null
  transcodedSize: number | null
  transcodedTime: number | null
  metadataJson: string
}

/**
 * One rung's execution detail, as far as it was usable.
 *
 * The documented fields are always present — an absent or wrongly-typed one
 * arrives as `null` — so a reader does not have to distinguish "this engine
 * build did not report bytes" from "this rung had no bytes key". A newer engine
 * may add further scalar fields; those ride along beside these.
 */
export type RenditionDiagnostic = {
  label: string
  width: number | null
  height: number | null
  bitrate: string | null
  backend: string | null
  mode: string | null
  attempts: number | null
  seconds: number | null
  bytes: number | null
}

/**
 * Per-rendition execution details, filtered down to what is actually usable.
 *
 * Why this is recorded at all: once a job can finish across more than one
 * encoder (`processing.backend === 'mixed'`), the whole-job backend no longer
 * answers "which encoder produced *this* rung, and on which toolchain?" — the
 * only place to answer it is per rung. Support asks that question after the
 * fact, when the job row is long gone, so the answer has to be on the video.
 *
 * Only entries that are objects carrying a string `label` survive: the label is
 * what ties a diagnostic back to a rung, so an entry without one answers
 * nothing. The documented fields are copied with the type the engine documents
 * for them, and any *other* field that arrives as a number or string is carried
 * through as well — diagnostics are additive by nature, and a newer engine's
 * extra counter should not need a server deploy to be recorded. Anything
 * untyped is dropped rather than passed through: a nested object is not a
 * diagnostic and has no business on the video row.
 *
 * Returns `[]` for a missing, empty or malformed array, and the caller then
 * omits the key entirely: `renditions: []` on an older video would read as "the
 * engine reported no renditions", which is a different thing from "this engine
 * build did not report per-rendition details".
 */
function parseRenditionDiagnostics(value: unknown): RenditionDiagnostic[] {
  if (!Array.isArray(value)) return []

  const renditions: RenditionDiagnostic[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.label !== 'string') continue

    const diagnostic: Record<string, string | number | null> = {
      label: record.label,
      width: typeof record.width === 'number' ? record.width : null,
      height: typeof record.height === 'number' ? record.height : null,
      bitrate: typeof record.bitrate === 'string' ? record.bitrate : null,
      backend: typeof record.backend === 'string' ? record.backend : null,
      mode: typeof record.mode === 'string' ? record.mode : null,
      attempts: typeof record.attempts === 'number' ? record.attempts : null,
      seconds: typeof record.seconds === 'number' ? record.seconds : null,
      bytes: typeof record.bytes === 'number' ? record.bytes : null,
    }
    for (const [key, field] of Object.entries(record)) {
      if (key in diagnostic) continue
      if (typeof field === 'number' || typeof field === 'string') diagnostic[key] = field
    }
    renditions.push(diagnostic as RenditionDiagnostic)
  }
  return renditions
}

/**
 * Toolchain versions behind the attempt: engine build, plan version, FFmpeg and
 * Shaka.
 *
 * Why this is recorded: a diagnostic report is only actionable later if the
 * versions travelled with the video — "the ladder broke under ffmpeg 9.0.1" is
 * unanswerable once the job row is gone, and a rolling upgrade means the version
 * in the image today is not the one that produced these bytes. Key names are
 * kept as the engine writes them (`planVersion`, not `plan_version`) so the
 * payload and the stored metadata can be compared by eye.
 *
 * Only string-valued entries survive, and `null` is returned when the incoming
 * value is not a non-null object or when nothing usable remains — the caller
 * omits the key entirely in that case, for the same reason as `renditions`.
 */
function parseToolchainDiagnostics(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const toolchain: Record<string, string> = {}
  for (const [key, version] of Object.entries(value as Record<string, unknown>)) {
    if (typeof version === 'string') toolchain[key] = version
  }
  return Object.keys(toolchain).length > 0 ? toolchain : null
}

export type ParseCompletionOptions = {
  /** Attempt prefix for self-hosted artifacts. Null keeps the legacy layout. */
  outputPrefix?: string | null
  deliveryBaseUrl: string
  /** Previous `video.metadata`, so unrelated keys survive the update. */
  prevMetadata?: Record<string, unknown> | null
  now?: Date
}

/**
 * Resolve an artifact path to a public URL.
 *
 * Self-hosted agents report paths **relative to their attempt prefix**, because
 * the agent has no idea what the delivery base URL is and must not be trusted to
 * assert it. Two things are therefore forced here:
 *
 * 1. **The host is ours.** An absolute URL in the payload is reduced to its
 *    pathname; an agent cannot point a viewer's player at another origin. The
 *    host is taken from configuration, never from the payload.
 * 2. **The prefix is a floor, not a hint.** `.` and `..` segments are dropped
 *    rather than resolved, so `../../<other-video>/playlist.m3u8` cannot climb
 *    out of this attempt's directory. In an object key there is no parent to
 *    climb to, and pretending otherwise is how a prefix check gets bypassed.
 */
function resolveArtifact(
  value: unknown,
  outputPrefix: string | null,
  deliveryBaseUrl: string,
): string | null {
  if (typeof value !== 'string' || !value) return null
  const relative = normalizeKeyPath(value)
  if (!relative) return null
  const key = outputPrefix ? `${outputPrefix.replace(/\/+$/, '')}/${relative}` : relative
  return joinUrl(deliveryBaseUrl, key)
}

/** Key-safe path: no scheme, no authority, no parent segments, no empties. */
export function normalizeKeyPath(value: string): string {
  let candidate = value.replace(/\\/g, '/')

  // An absolute URL is reduced to its pathname. The authority is discarded
  // outright rather than carried into the key — honouring it in any form is how
  // a payload ends up steering a viewer at a host we do not control.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    const afterScheme = candidate.slice(candidate.indexOf('://') + 3)
    const slash = afterScheme.indexOf('/')
    candidate = slash === -1 ? '' : afterScheme.slice(slash)
  }

  return candidate
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/')
}

export function parseCompletionPayload(
  payload: Record<string, unknown>,
  options: ParseCompletionOptions,
): ParsedCompletion {
  const { outputPrefix = null, deliveryBaseUrl, prevMetadata = null, now = new Date() } = options

  const outputs = (payload.outputs ?? {}) as Record<string, unknown>
  const meta = (payload.metadata ?? {}) as Record<string, unknown>
  const processing = (payload.processing ?? {}) as Record<string, unknown>
  const subtitle = (payload.subtitle ?? {}) as Record<string, unknown>
  const chapters = (payload.chapters ?? {}) as Record<string, unknown>

  const duration =
    typeof meta.duration === 'number' && meta.duration >= 0 ? meta.duration : null

  const resolutions = Array.isArray(outputs.renditions)
    ? (outputs.renditions.filter((entry) => typeof entry === 'string') as string[])
    : null

  let subtitleStatus: string | null = null
  if (subtitle.requested) {
    subtitleStatus =
      typeof subtitle.status === 'string'
        ? subtitle.status
        : subtitle.generated
          ? 'completed'
          : 'failed'
  }

  let chaptersStatus: string | null = null
  let chaptersData: ParsedCompletion['chapters'] = null
  if (chapters.requested) {
    chaptersStatus =
      typeof chapters.status === 'string'
        ? chapters.status
        : chapters.generated
          ? 'completed'
          : 'failed'
    if (chapters.generated && Array.isArray(chapters.data)) {
      chaptersData = chapters.data as ParsedCompletion['chapters']
    }
  }

  // `subtitles` may arrive as an absolute URL (legacy Modal) or as a relative
  // path (self-hosted). Only the relative form is re-based; an absolute one is
  // passed through unchanged so existing videos keep working.
  const subtitleArtifact =
    typeof outputs.subtitles === 'string'
      ? outputs.subtitles
      : typeof subtitle.url === 'string' && subtitle.generated
        ? subtitle.url
        : null

  // Diagnostics for support: "which encoder produced this rung, and on which
  // toolchain?" Both are additive — an older engine sends neither key, and both
  // are omitted below when nothing usable arrived, so an existing video's
  // metadata keeps exactly the shape it had.
  const renditions = parseRenditionDiagnostics(processing.renditions)
  const toolchain = parseToolchainDiagnostics(processing.toolchain)

  const metadataJson = JSON.stringify({
    ...(prevMetadata ?? {}),
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    has_audio: meta.has_audio,
    is_hdr: meta.is_hdr,
    is_vertical: meta.is_vertical,
    aspect_ratio: meta.aspect_ratio,
    duration_exact: duration,
    processing_time: processing.total_time,
    transcode_time: processing.transcode_time,
    processing_speed: processing.processing_speed,
    files_uploaded: processing.files_uploaded,
    source_size_mb: processing.source_size_mb,
    transcoded_size_mb: processing.transcoded_size_mb,
    // A single encoder name (`cpu` | `nvenc` | `vaapi`) — or the literal
    // `"mixed"`, which reports that the ladder finished across more than one
    // encoder because every rendition carries its own fallback state. It stays
    // the coarse whole-job summary; the per-rung answer is `renditions` below.
    backend: processing.backend,
    fallbacks: processing.fallbacks,
    plan_fingerprint: processing.plan_fingerprint,
    ...(renditions.length > 0 ? { renditions } : {}),
    ...(toolchain ? { toolchain } : {}),
    dash_manifest: outputs.dash_manifest,
    playback_policy: payload.playback_policy,
    encrypted: payload.encrypted,
    subtitle_requested: subtitle.requested,
    subtitle_generated: subtitle.generated,
    chapters_requested: chapters.requested,
    chapters_generated: chapters.generated,
    transcoded_at: now.toISOString(),
  })

  return {
    hlsUrl: resolveArtifact(outputs.hls_playlist, outputPrefix, deliveryBaseUrl),
    thumbnailUrl: resolveArtifact(outputs.poster, outputPrefix, deliveryBaseUrl),
    subtitleUrl: resolveArtifact(subtitleArtifact, outputPrefix, deliveryBaseUrl),
    subtitleStatus,
    chaptersStatus,
    chapters: chaptersData,
    duration,
    resolutions,
    transcodedSize:
      typeof processing.transcoded_size === 'number' ? processing.transcoded_size : null,
    transcodedTime:
      typeof processing.transcode_time === 'number'
        ? Math.round(processing.transcode_time)
        : null,
    metadataJson,
  }
}

/**
 * The ownership guard, re-asserted inside the mutation.
 *
 * The read that decided to apply this callback happened in an earlier statement;
 * a claim landing in between must still win. `IS NOT DISTINCT FROM` handles the
 * legacy row with no attempt id, which is what lets a rolling upgrade deliver
 * in-flight callbacks instead of dropping them.
 */
export function ownershipPredicate(attemptId: string | null): SQL {
  return attemptId
    ? sql`transcode_attempt_id = ${attemptId}`
    : sql`transcode_attempt_id IS NULL`
}

/**
 * Inventory gate for self-hosted publication.
 *
 * Expressed as an `EXISTS` over two correlated conditions rather than a
 * pre-computed boolean, so a row that is deleted or re-verified between the read
 * and the write cannot slip through:
 *
 *   - the inventory is `verified`, and
 *   - it belongs to *this* attempt, and
 *   - its item set matches the attempt's prefix.
 *
 * A Modal callback has no inventory and passes no gate: its outputs were
 * uploaded over a secret the API itself issued, and requiring a table that the
 * Modal path does not populate would break every existing installation.
 */
export function inventoryVerifiedPredicate(
  videoId: string,
  attemptId: string | null,
): SQL | null {
  if (!attemptId) return null
  return sql`EXISTS (
    SELECT 1 FROM artifact_inventory AS inv
    WHERE inv.video_id = ${videoId}::uuid
      AND inv.attempt_id = ${attemptId}
      AND inv.status = 'verified'
      AND inv.item_count > 0
      AND inv.verified_count = inv.item_count
  )`
}

export type FinalizeSuccessInput = {
  videoId: string
  organizationId: string
  title: string
  /**
   * The attempt that must still own the row. `null` means "the row has no
   * attempt id" (a legacy dispatch); callers must pass the value they read.
   */
  attemptId: string | null
  payload: Record<string, unknown>
  outputPrefix?: string | null
  deliveryBaseUrl: string
  prevMetadata?: Record<string, unknown> | null
  /** Require a fully verified artifact inventory before publishing. */
  requireVerifiedInventory?: boolean
  /** Clause that selects the published prefix; defaults to the attempt prefix. */
  publishedPrefix?: string | null
  now?: Date
}

export type FinalizeSuccessResult =
  | {
      applied: true
      eventId: string
      hlsUrl: string | null
      thumbnailUrl: string | null
      subtitleUrl: string | null
      subtitleStatus: string | null
      chaptersStatus: string | null
      chapters: Array<{ startTime: number; endTime: number; title: string }> | null
    }
  | { applied: false; reason: string }

/**
 * Mark a video ready, record `video.ready`, and select its output prefix — in
 * one statement.
 *
 * Returns `{ applied: false }` for a duplicate or superseded callback, a deleted
 * video, or an unverified inventory. In every one of those cases **no event was
 * written**, which is the correct outcome: there is no state change to announce.
 */
/**
 * Build the publication statement and its parsed values.
 *
 * Exported so a caller that must pair publication with a second write (the
 * self-hosted job row) can run both in one transaction rather than re-deriving
 * the statement — see `finalizeAndSucceed`.
 */
export function buildSuccessStatement(
  input: FinalizeSuccessInput,
): { statement: SQL; parsed: ParsedCompletion; eventId: string } {
  const parsed = parseCompletionPayload(input.payload, {
    outputPrefix: input.outputPrefix ?? null,
    deliveryBaseUrl: input.deliveryBaseUrl,
    prevMetadata: input.prevMetadata ?? null,
    now: input.now,
  })

  const guards: SQL[] = [
    sql`status IN ('uploading', 'processing')`,
    ownershipPredicate(input.attemptId),
  ]

  if (input.requireVerifiedInventory && input.attemptId) {
    const gate = inventoryVerifiedPredicate(input.videoId, input.attemptId)
    if (gate) guards.push(gate)
  }

  const eventId = newEventId()
  const guardClause = sql.join(
    [sql`AND deleted_at IS NULL`, ...guards.map((guard) => sql`AND ${guard}`)],
    sql` `,
  )

  // `published_prefix` is written into metadata rather than a dedicated column:
  // it is diagnostics (which attempt's bytes are live), not something the read
  // path branches on, and the read path resolving it would be a second source of
  // truth for `hls_url`.
  const statement = sql`
    WITH updated AS (
      UPDATE video
      SET status = 'ready',
          hls_url = ${parsed.hlsUrl},
          thumbnail_url = ${parsed.thumbnailUrl},
          duration = ${parsed.duration != null ? Math.floor(parsed.duration) : null},
          resolutions = ${parsed.resolutions ? JSON.stringify(parsed.resolutions) : null},
          subtitle_status = ${parsed.subtitleStatus},
          subtitle_url = ${parsed.subtitleUrl},
          chapters_status = ${parsed.chaptersStatus},
          chapters = ${parsed.chapters ? JSON.stringify(parsed.chapters) : null}::jsonb,
          transcoded_size = ${parsed.transcodedSize},
          transcoded_time = ${parsed.transcodedTime},
          metadata = ${parsed.metadataJson},
          transcode_attempt_id = NULL,
          transcode_lease_expires_at = NULL,
          failure_code = NULL,
          last_heartbeat_at = now(),
          updated_at = now()
      WHERE id = ${input.videoId} ${guardClause}
      RETURNING id
    )
    INSERT INTO event_outbox (id, organization_id, event, payload)
    SELECT ${eventId},
           ${input.organizationId},
           'video.ready',
           ${JSON.stringify({
             videoId: input.videoId,
             title: input.title,
             status: 'ready',
             duration: parsed.duration,
             hlsUrl: parsed.hlsUrl,
             thumbnailUrl: parsed.thumbnailUrl,
             publishedPrefix: input.publishedPrefix ?? null,
           })}::jsonb
    FROM updated
    RETURNING id
  `

  return { statement, parsed, eventId }
}

export async function finalizeVideoSuccess(
  executor: AtomicExecutor,
  input: FinalizeSuccessInput,
): Promise<FinalizeSuccessResult> {
  const { statement, parsed, eventId } = buildSuccessStatement(input)
  const outcome = await runAtomicIntent(executor, statement)
  if (!outcome.applied) {
    return { applied: false, reason: 'transition-not-applied' }
  }

  return {
    applied: true,
    eventId,
    hlsUrl: parsed.hlsUrl,
    thumbnailUrl: parsed.thumbnailUrl,
    subtitleUrl: parsed.subtitleUrl,
    subtitleStatus: parsed.subtitleStatus,
    chaptersStatus: parsed.chaptersStatus,
    chapters: parsed.chapters,
  }
}

/**
 * Publish a video **and** finish its self-hosted job, atomically.
 *
 * Two writes that must not be separable: a crash between them leaves a `ready`
 * video beside a `publishing` job, and the replay that follows finds a ready
 * video and a job the agent can no longer address — a stuck job over a video
 * that is actually fine. One transaction removes the window rather than adding
 * a repair path for it.
 *
 * `succeedJob` is injected rather than imported so this module keeps its
 * dependency direction (the queue depends on the finalizer's prefix helper, not
 * the reverse).
 */
/**
 * Assert that publication and job finalization agreed.
 *
 * Returned as a *statement* rather than a JavaScript check so a split
 * publication/job-finalization result aborts the surrounding transaction with a
 * named error. The cast raises `invalid input syntax for type integer:
 * "publication diverged"`, which names the problem in the error the caller sees.
 *
 * Both-agree is the success case in either direction: both empty is a stale
 * completion (nothing happened, correctly), both present is a normal
 * publication. Only a split is fatal.
 */
export function buildPublicationAgreementAssertion(input: {
  videoId: string
  jobId: string
}): SQL {
  return sql`
    SELECT CAST(
      CASE
        WHEN (
          (SELECT count(*) FROM video
            WHERE id = ${input.videoId}::uuid AND status = 'ready')
          =
          (SELECT count(*) FROM transcode_job
            WHERE id = ${input.jobId}::uuid AND state = 'succeeded')
        ) THEN '1'
        ELSE 'publication diverged'
      END AS int
    ) AS agreed
  `
}

export async function finalizeAndSucceed(
  executor: AtomicExecutor,
  input: FinalizeSuccessInput & { jobId: string },
  succeedJobStatement: (jobId: string, attemptId: string) => SQL,
): Promise<FinalizeSuccessResult> {
  const atomic = executor as AtomicExecutor & AtomicBatchExecutor
  if (!supportsAtomicBatch(atomic)) {
    throw new Error('atomic publication requires postgres-js transaction()')
  }

  const { statement, parsed, eventId } = buildSuccessStatement(input)
  const jobStatement = succeedJobStatement(input.jobId, input.attemptId ?? '')
  const assertion = buildPublicationAgreementAssertion({
    videoId: input.videoId,
    jobId: input.jobId,
  })

  let published: Record<string, unknown>[]
  let jobAdvanced: Record<string, unknown>[]

  if (typeof atomic.transaction === 'function') {
    // postgres-js: inspect inside the transaction so a split throws *before*
    // commit. Checking afterwards would run against an already-committed
    // transaction, which is how a half-applied publication gets committed and
    // then reported as an error.
    const outcome = (await atomic.transaction(async (tx: never) => {
      const scoped = tx as unknown as AtomicExecutor
      const publishedRows = normalizeRows(await scoped.execute(statement))
      const jobRows = normalizeRows(await scoped.execute(jobStatement))
      if ((publishedRows.length === 0) !== (jobRows.length === 0)) {
        throw new Error(
          'publication diverged: the video and its job did not both advance ' +
            `(published=${publishedRows.length}, job=${jobRows.length})`,
        )
      }
      return { publishedRows, jobRows }
    })) as { publishedRows: Record<string, unknown>[]; jobRows: Record<string, unknown>[] }
    published = outcome.publishedRows
    jobAdvanced = outcome.jobRows
  } else {
    throw new Error('atomic publication requires postgres-js transaction()')
  }

  if (published.length === 0) {
    return { applied: false, reason: 'transition-not-applied' }
  }

  return {
    applied: true,
    eventId,
    hlsUrl: parsed.hlsUrl,
    thumbnailUrl: parsed.thumbnailUrl,
    subtitleUrl: parsed.subtitleUrl,
    subtitleStatus: parsed.subtitleStatus,
    chaptersStatus: parsed.chaptersStatus,
    chapters: parsed.chapters,
  }
}

export type FinalizeFailureInput = {
  videoId: string
  organizationId: string
  title: string
  attemptId: string | null
  message: string
  failureCode?: string | null
  /** Preserved so the sweeper can tell a timeout from a provider error. */
  additionalMetadata?: Record<string, unknown>
  prevMetadata?: Record<string, unknown> | null
  now?: Date
}

export type FinalizeFailureResult =
  | { applied: true; eventId: string }
  | { applied: false; reason: string }

/**
 * Mark a video failed and record `video.failed`, in one statement.
 *
 * `failure_code` is written here rather than by the caller so every provider
 * reports the same machine-readable vocabulary, and so a typed code can never be
 * set on a row without the matching event.
 */
export async function finalizeVideoFailure(
  executor: AtomicExecutor,
  input: FinalizeFailureInput,
): Promise<FinalizeFailureResult> {
  const now = input.now ?? new Date()
  const metadataJson = JSON.stringify({
    ...(input.prevMetadata ?? {}),
    error: input.message,
    failure_code: input.failureCode ?? null,
    failed_at: now.toISOString(),
    ...(input.additionalMetadata ?? {}),
  })

  const eventId = newEventId()
  const statement = sql`
    WITH updated AS (
      UPDATE video
      SET status = 'failed',
          metadata = ${metadataJson},
          failure_code = ${input.failureCode ?? null},
          transcode_attempt_id = NULL,
          transcode_lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${input.videoId}
        AND deleted_at IS NULL
        AND status IN ('uploading', 'processing')
        AND ${ownershipPredicate(input.attemptId)}
      RETURNING id
    )
    INSERT INTO event_outbox (id, organization_id, event, payload)
    SELECT ${eventId},
           ${input.organizationId},
           'video.failed',
           ${JSON.stringify({
             videoId: input.videoId,
             title: input.title,
             error: input.message,
             failureCode: input.failureCode ?? null,
           })}::jsonb
    FROM updated
    RETURNING id
  `

  const outcome = await runAtomicIntent(executor, statement)
  if (!outcome.applied) {
    return { applied: false, reason: 'transition-not-applied' }
  }
  return { applied: true, eventId }
}

/** Events a completion may additionally emit, mirroring the Modal handler. */
export function completionSideEvents(
  result: { subtitleStatus: string | null; chaptersStatus: string | null },
  payload: Record<string, unknown>,
): Array<{ event: WebhookEvent; payload: Record<string, unknown> }> {
  const events: Array<{ event: WebhookEvent; payload: Record<string, unknown> }> = []
  const subtitle = (payload.subtitle ?? {}) as Record<string, unknown>
  const chapters = (payload.chapters ?? {}) as Record<string, unknown>

  if (subtitle.requested) {
    if (result.subtitleStatus === 'completed') {
      events.push({ event: 'subtitle.generated', payload: {} })
    } else if (result.subtitleStatus === 'failed') {
      events.push({ event: 'subtitle.failed', payload: {} })
    }
  }

  if (chapters.requested) {
    if (result.chaptersStatus === 'completed') {
      events.push({ event: 'chapters.generated', payload: {} })
    } else if (result.chaptersStatus === 'failed') {
      events.push({ event: 'chapters.failed', payload: {} })
    }
  }

  return events
}
