/**
 * Playback journal validation.
 *
 * The public player endpoint accepts the existing event format. This module
 * bounds the body, checks required fields / finite numbers / Analytics Engine
 * field-size limits, and caps the accepted batch at Cloudflare's per-invocation
 * writeDataPoint limit. Organization ownership is resolved later, per video.
 */

import { WAE_MAX_DATA_POINTS_PER_INVOCATION } from './analytics-engine'
import type { PlaybackRow } from '../runtime/types'

export const JOURNAL_MAX_BODY_BYTES = 1024 * 1024

/** Cloudflare Analytics Engine index (organizationId) is 96 bytes. */
export const AE_INDEX_MAX_BYTES = 96
/**
 * Combined UTF-8 size of every blob on one Analytics Engine data point.
 * https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */
export const AE_BLOBS_TOTAL_MAX_BYTES = 16 * 1024
/** A single blob cannot exceed the combined data-point cap. */
export const AE_BLOB_MAX_BYTES = AE_BLOBS_TOTAL_MAX_BYTES

export type ClientPlaybackEvent = {
  event: string
  ts: string
  videoId: string
  sessionId: string
  userId?: string | null
  currentTime?: number
  duration?: number
  watchedDelta?: number
  errorCode?: string
}

export type ValidatedPlaybackEvent = {
  event: string
  ts: string
  videoId: string
  sessionId: string
  userId: string
  currentTime: number
  duration: number
  watchedDelta: number
  errorCode: string
}

export type JournalParseResult =
  | {
      ok: true
      events: ValidatedPlaybackEvent[]
      received: number
      truncated: boolean
    }
  | { ok: false; error: string; status: 400 }

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function combinedBlobsBytes(blobs: readonly string[]): number {
  let total = 0
  for (const blob of blobs) total += utf8Bytes(blob)
  return total
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function boundedBlob(value: string): boolean {
  return utf8Bytes(value) <= AE_BLOB_MAX_BYTES
}

function requiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || !boundedBlob(trimmed)) return null
  return trimmed
}

/**
 * Parse and validate a journal JSON body that has already been size-checked.
 *
 * Invalid individual events are dropped rather than failing the request: a
 * mixed batch from several players must not lose the valid rows. An empty or
 * non-array body is a client error.
 */
export function parseJournalEvents(body: unknown): JournalParseResult {
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, error: 'Invalid payload: expected non-empty array', status: 400 }
  }

  const received = body.length
  const accepted: ValidatedPlaybackEvent[] = []
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as ClientPlaybackEvent
    const name = requiredString(event.event)
    const ts = requiredString(event.ts)
    const videoId = requiredString(event.videoId)
    const sessionId = requiredString(event.sessionId)
    if (!name || !ts || !videoId || !sessionId) continue
    if (!isFiniteNumber(event.currentTime) || !isFiniteNumber(event.duration) || !isFiniteNumber(event.watchedDelta)) {
      continue
    }
    const userId = typeof event.userId === 'string' ? event.userId : ''
    const errorCode = typeof event.errorCode === 'string' ? event.errorCode : ''
    if (!boundedBlob(userId) || !boundedBlob(errorCode)) continue
    accepted.push({
      event: name,
      ts,
      videoId,
      sessionId,
      userId,
      currentTime: event.currentTime,
      duration: event.duration,
      watchedDelta: event.watchedDelta,
      errorCode,
    })
  }

  const truncated = accepted.length > WAE_MAX_DATA_POINTS_PER_INVOCATION
  return {
    ok: true,
    events: accepted.slice(0, WAE_MAX_DATA_POINTS_PER_INVOCATION),
    received,
    truncated,
  }
}

export function toPlaybackRow(
  event: ValidatedPlaybackEvent,
  extras: {
    organizationId: string
    country: string
    device: string
    browser: string
  },
): PlaybackRow | null {
  if (utf8Bytes(extras.organizationId) > AE_INDEX_MAX_BYTES) return null
  if (!boundedBlob(extras.country) || !boundedBlob(extras.device) || !boundedBlob(extras.browser)) {
    return null
  }
  const blobs = [
    event.event,
    event.videoId,
    event.sessionId,
    extras.country,
    extras.device,
    extras.browser,
    event.errorCode,
    event.userId,
  ]
  if (combinedBlobsBytes(blobs) > AE_BLOBS_TOTAL_MAX_BYTES) return null
  return {
    event: event.event,
    videoId: event.videoId,
    sessionId: event.sessionId,
    userId: event.userId,
    country: extras.country,
    device: extras.device,
    browser: extras.browser,
    errorCode: event.errorCode,
    watchedDelta: event.watchedDelta,
    currentTime: event.currentTime,
    duration: event.duration,
    organizationId: extras.organizationId,
  }
}

export function bodyByteLength(raw: string): number {
  return utf8Bytes(raw)
}

const VIDEO_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isVideoUuid(value: string): boolean {
  return VIDEO_ID_UUID.test(value)
}

export type LimitedText =
  | { ok: true; text: string }
  | { ok: false; status: 413 | 400; error: string }

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel()
  } catch {
    // Already locked or consumed.
  }
}

/**
 * Read a request body as UTF-8 text, aborting as soon as it exceeds `maxBytes`.
 * A declared Content-Length over the cap never starts the stream.
 */
export async function readTextWithLimit(request: Request, maxBytes: number): Promise<LimitedText> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      await cancelBody(request)
      return { ok: false, status: 413, error: 'Payload too large' }
    }
  }

  const reader = request.body?.getReader()
  if (!reader) return { ok: true, text: '' }

  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, status: 413, error: 'Payload too large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, status: 400, error: 'Malformed payload' }
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, text: new TextDecoder().decode(bytes) }
}
