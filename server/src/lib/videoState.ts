/**
 * Video lifecycle state machine (pure rules — no I/O).
 *
 * Statuses: pending → uploading → processing → ready | failed
 *
 * The rules here are the single source of truth for allowed transitions.
 * Routes, the transcode webhook, retry endpoints and the job sweeper all
 * consult them before touching the DB, so out-of-order webhooks can never
 * corrupt state (no resurrecting failed videos, no downgrading ready ones).
 */

export const VIDEO_STATUSES = [
  'pending',
  'uploading',
  'processing',
  'ready',
  'failed',
] as const

export type VideoStatus = (typeof VIDEO_STATUSES)[number]

const ALLOWED_TRANSITIONS: Record<VideoStatus, readonly VideoStatus[]> = {
  pending: ['uploading', 'failed'],
  uploading: ['processing', 'failed'],
  processing: ['ready', 'failed'],
  // Direct failed -> ready is forbidden: retries must pass through an explicit
  // retry endpoint that re-dispatches the job (and sets a fresh attempt).
  ready: ['failed'],
  failed: [],
}

export function isVideoStatus(value: string): value is VideoStatus {
  return (VIDEO_STATUSES as readonly string[]).includes(value)
}

export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  if (!isVideoStatus(from) || !isVideoStatus(to)) return false
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export type CallbackKind = 'success' | 'error'

export type CallbackDecision =
  | { apply: true }
  | { apply: false; reason: string }

/**
 * Decide whether a transcode callback (success/error) may advance the given
 * current status. Pure guard used by the /api/webhook/transcode-complete
 * handler before any DB write.
 */
export function decideCallbackTransition(
  current: VideoStatus,
  callback: CallbackKind,
): CallbackDecision {
  if (current === 'ready') {
    return {
      apply: false,
      reason: `late ${callback} callback ignored: video already ready`,
    }
  }
  if (current === 'failed') {
    if (callback === 'success') {
      return {
        apply: false,
        reason: 'late success callback ignored: video failed; retry via the retry endpoint',
      }
    }
    return { apply: false, reason: 'duplicate error callback ignored: video already failed' }
  }
  if (current === 'pending') {
    return { apply: false, reason: 'callback for a pending video ignored' }
  }
  // uploading / processing
  return { apply: true }
}
