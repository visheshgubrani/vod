/**
 * Provider-aware dispatch: the one place a completed upload becomes work.
 *
 * Browser and SDK uploads always place bytes in R2 first. The deployment's
 * provider decides which worker receives the job: Modal dispatches immediately,
 * while the single local worker claims a durable Postgres queue row. The
 * provider is recorded on the job so changing the deployment never reroutes
 * accepted work.
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
  processingOptions?: Record<string, unknown>
  env?: EnvLike
}

export type ProviderDispatchResult = DispatchTranscodeResult & {
  provider: TranscodeProvider
  /** Set for a local-provider job. */
  jobId?: string
}

/** Resolve the installation provider for a new job. */
export function resolveProvider(
  env?: EnvLike,
): { ok: true; provider: TranscodeProvider } {
  return { ok: true, provider: loadProviderSettings(env ?? {}).transcodeProvider }
}

/** Whether new local submissions should be accepted; this never affects queued work. */
export function localSubmissionAllowed(provider: TranscodeProvider, env?: EnvLike): boolean {
  if (provider !== 'local') return true
  return loadProviderSettings(env ?? {}).localTranscodeEnabled
}

export async function dispatchWithProvider(
  input: ProviderDispatchInput,
): Promise<ProviderDispatchResult> {
  const resolution = resolveProvider(input.env)
  if (!resolution.ok) {
    return {
      dispatched: false,
      reason: 'dispatch-failed',
      provider: 'modal',
    }
  }

  const provider = resolution.provider

  if (provider === 'local') {
    if (!localSubmissionAllowed(provider, input.env)) {
      // Refuse rather than sending an explicitly local job to a different provider.
      return {
        dispatched: false,
        reason: 'provider-disabled',
        provider: 'local',
      }
    }
    return dispatchLocal(input)
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
 * Enqueue an uploaded object for the managed local worker.
 *
 * Uploaded bytes remain tenant-owned in R2. The deployment-local worker can
 * claim them regardless of organization; tenant identity comes from the job.
 */
async function dispatchLocal(
  input: ProviderDispatchInput,
): Promise<ProviderDispatchResult> {
  const source = await db
    .insert(transcodeSource)
    .values({
      organizationId: input.organizationId,
      kind: 'r2',
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
    provider: 'local',
    options: {
      ...(input.processingOptions ?? {}),
      provider: 'local',
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
    return { dispatched: false, reason: 'not-found', provider: 'local' }
  }

  return {
    dispatched: true,
    attemptId: '',
    jobAttempts: 0,
    provider: 'local',
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
