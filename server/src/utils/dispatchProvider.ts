/**
 * Provider-aware dispatch: the one place a completed upload becomes work.
 *
 * The raw bucket's role changed with self-hosting. It used to be a hard
 * prerequisite: bytes landed in R2 and Modal read them. Now it is *conditional on
 * uploading* — a file on the owner's machine needs no bucket at all — while an
 * uploaded file still needs somewhere for the bytes to wait, whichever engine
 * will read them.
 *
 * So this module answers two questions in one place, so the upload call sites
 * cannot disagree:
 *
 *   1. **Which provider?** The per-request `transcodingProvider` if the caller
 *      named one, otherwise the installation default. Stored on the job, never
 *      re-derived — changing the default must not reroute queued work.
 *   2. **How does the job get created?** Modal mints an attempt and POSTs it; a
 *      self-hosted job is enqueued for an agent to claim, which mints the attempt
 *      itself when it actually starts.
 *
 * The second difference is why this is not a rename. A queued local job holds
 * **no** attempt id and **no** lease, so it consumes neither a processing attempt
 * nor an organization concurrency slot while it waits for an agent. That is the
 * behaviour the plan asks for, and it comes from the enqueue statement rather
 * than from anything in this file.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '../lib/database'
import { transcodeSource, video } from '../db/schema'
import { enqueueLocalJob } from '../lib/localJobQueue'
import { loadProviderSettings, type TranscodeProvider } from '../lib/config'
import {
  dispatchTranscodeJob,
  type DispatchTranscodeResult,
} from './dispatchTranscode'
import type { EnvLike } from '../lib/config'

export type ProviderDispatchInput = {
  videoId: string
  organizationId: string
  rawKey: string
  rawBucket: string | null
  playbackPolicy?: 'public' | 'signed'
  generateSubtitle?: boolean
  generateChapters?: boolean
  /** Per-request override; omitted means the installation default. */
  transcodingProvider?: string | null
  processingOptions?: Record<string, unknown>
  env?: EnvLike
}

export type ProviderDispatchResult = DispatchTranscodeResult & {
  provider: TranscodeProvider
  /** Set for a self-hosted job. */
  jobId?: string
}

/**
 * Resolve the provider for one request.
 *
 * An unrecognised value is *not* silently treated as the default: a caller that
 * asked for something the server cannot do should be told, not quietly given a
 * different engine. The upload route turns this into a 400.
 */
export function resolveProvider(
  requested: string | null | undefined,
  env?: EnvLike,
): { ok: true; provider: TranscodeProvider } | { ok: false; reason: string } {
  const fallback = loadProviderSettings(env ?? {}).transcodeProvider

  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, provider: fallback }
  }
  const normalized = String(requested).trim().toLowerCase()
  if (normalized === 'modal') return { ok: true, provider: 'modal' }
  if (normalized === 'self-hosted' || normalized === 'selfhosted' || normalized === 'local') {
    return { ok: true, provider: 'self-hosted' }
  }
  return { ok: false, reason: `transcodingProvider must be "modal" or "self-hosted"` }
}

/**
 * Whether a self-hosted submission should be accepted right now.
 *
 * `SELF_HOSTED_ENABLED=false` is the documented rollback: it stops new local
 * submissions and cancels nothing. An explicit per-request choice is still
 * refused, because the point of the switch is to stop work starting.
 */
export function selfHostedSubmissionAllowed(
  provider: TranscodeProvider,
  env?: EnvLike,
): boolean {
  if (provider !== 'self-hosted') return true
  return loadProviderSettings(env ?? {}).selfHostedEnabled
}

export async function dispatchWithProvider(
  input: ProviderDispatchInput,
): Promise<ProviderDispatchResult> {
  const resolution = resolveProvider(input.transcodingProvider, input.env)
  if (!resolution.ok) {
    return {
      dispatched: false,
      reason: 'dispatch-failed',
      provider: 'modal',
    }
  }

  const provider = resolution.provider

  if (provider === 'self-hosted') {
    if (!selfHostedSubmissionAllowed(provider, input.env)) {
      // The rollback switch. Refusing here — rather than falling back to Modal —
      // is the whole point: an owner who turned local encoding off did not ask
      // for their files to be uploaded to someone else's cloud.
      return {
        dispatched: false,
        reason: 'provider-disabled',
        provider: 'self-hosted',
      }
    }
    return dispatchSelfHosted(input)
  }

  const result = await dispatchTranscodeJob({
    videoId: input.videoId,
    rawKey: input.rawKey,
    organizationId: input.organizationId,
    playbackPolicy: input.playbackPolicy,
    generateSubtitle: input.generateSubtitle,
    generateChapters: input.generateChapters,
    env: input.env,
  })
  return { ...result, provider: 'modal' }
}

/**
 * Enqueue an uploaded object for a self-hosted agent.
 *
 * The source is an `r2` source with **no bound agent**, which is what makes it
 * runnable by any eligible machine in the organization. A `local` source is
 * pinned to the machine holding the file; this one is not, and copying that
 * binding here would make an uploaded file wait for one specific computer.
 */
async function dispatchSelfHosted(
  input: ProviderDispatchInput,
): Promise<ProviderDispatchResult> {
  const source = await db
    .insert(transcodeSource)
    .values({
      organizationId: input.organizationId,
      kind: 'r2',
      agentId: null,
      r2Bucket: input.rawBucket,
      r2Key: input.rawKey,
      fileName: input.rawKey.split('/').pop() ?? null,
      availability: 'available',
      lastVerifiedAt: new Date(),
    })
    .returning({ id: transcodeSource.id })

  const queued = await enqueueLocalJob(db, {
    videoId: input.videoId,
    organizationId: input.organizationId,
    sourceId: source[0].id,
    agentId: null,
    provider: 'self-hosted',
    options: {
      ...(input.processingOptions ?? {}),
      provider: 'self-hosted',
      playbackPolicy: input.playbackPolicy ?? 'public',
      organizationId: input.organizationId,
      videoId: input.videoId,
      generateSubtitle: input.generateSubtitle ?? false,
      generateChapters: input.generateChapters ?? false,
    },
  })

  if (!queued) {
    // `buildEnqueueStatement` only inserts the job when the video row could
    // transition. A null here means the video was deleted, or is already owned —
    // in both cases queuing would be wrong, so the row is left alone rather than
    // forced into `processing`.
    return { dispatched: false, reason: 'not-found', provider: 'self-hosted' }
  }

  return {
    dispatched: true,
    attemptId: '',
    jobAttempts: 0,
    provider: 'self-hosted',
    jobId: queued.jobId,
  }
}

/** Whether a video's raw object is still present, for the retry path. */
export async function videoHasRawObject(videoId: string): Promise<boolean> {
  const rows = await db
    .select({ rawKey: video.rawKey })
    .from(video)
    .where(and(eq(video.id, videoId)))
    .limit(1)
  return Boolean(rows[0]?.rawKey)
}
