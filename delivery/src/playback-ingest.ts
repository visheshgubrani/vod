/**
 * Internal playback-analytics ingest.
 *
 * Node forwards already-normalized rows here. This worker writes them into
 * PLAYBACK_ANALYTICS using the historical playback_events field layout. Viewer
 * metadata is taken from the payload — never from this invocation's request
 * headers — so the Node host's location or user-agent cannot leak into the
 * dataset.
 */

export const PLAYBACK_INGEST_PATH = '/internal/analytics/playback'
export const WAE_MAX_DATA_POINTS_PER_INVOCATION = 250
export const AE_INDEX_MAX_BYTES = 96
/**
 * Combined UTF-8 size of every blob on one Analytics Engine data point.
 * https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */
export const AE_BLOBS_TOTAL_MAX_BYTES = 16 * 1024
export const AE_BLOB_MAX_BYTES = AE_BLOBS_TOTAL_MAX_BYTES
export const INGEST_MAX_BODY_BYTES = 1024 * 1024

export type PlaybackIngestRow = {
  event: string
  videoId: string
  sessionId: string
  userId: string
  country: string
  device: string
  browser: string
  errorCode: string
  watchedDelta: number
  currentTime: number
  duration: number
  organizationId: string
}

export type AnalyticsEnginePoint = {
  blobs: string[]
  doubles: number[]
  indexes: string[]
}

export type IngestEnv = {
  ANALYTICS_ENABLED?: string
  ANALYTICS_INGEST_SECRET?: string
  PLAYBACK_ANALYTICS?: {
    writeDataPoint(point: AnalyticsEnginePoint): void
  }
  USAGE_ANALYTICS?: { writeDataPoint(point: AnalyticsEnginePoint): void }
}

export function analyticsEnabled(env: { ANALYTICS_ENABLED?: string }): boolean {
  const raw = env.ANALYTICS_ENABLED?.trim().toLowerCase()
  if (raw === 'false' || raw === '0') return false
  return true
}

export function secretsMatch(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.byteLength !== b.byteLength) return false
  let mismatch = 0
  for (let i = 0; i < a.byteLength; i++) {
    mismatch |= a[i]! ^ b[i]!
  }
  return mismatch === 0
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function combinedBlobsBytes(blobs: readonly string[]): number {
  let total = 0
  for (const blob of blobs) total += utf8Bytes(blob)
  return total
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function requiredString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (utf8Bytes(value) > maxBytes) return null
  return value
}

export function playbackDataPoint(row: PlaybackIngestRow): AnalyticsEnginePoint {
  return {
    blobs: [
      row.event,
      row.videoId,
      row.sessionId,
      row.country,
      row.device,
      row.browser,
      row.errorCode,
      row.userId,
    ],
    doubles: [row.watchedDelta, row.currentTime, row.duration],
    indexes: [row.organizationId || 'unknown'],
  }
}

export function parseIngestRows(body: unknown): PlaybackIngestRow[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { events?: unknown }).events)) {
    return null
  }
  const events = (body as { events: unknown[] }).events
  const rows: PlaybackIngestRow[] = []
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as Record<string, unknown>
    const organizationId = requiredString(event.organizationId, AE_INDEX_MAX_BYTES)
    const name = requiredString(event.event, AE_BLOB_MAX_BYTES)
    const videoId = requiredString(event.videoId, AE_BLOB_MAX_BYTES)
    const sessionId = requiredString(event.sessionId, AE_BLOB_MAX_BYTES)
    const country = requiredString(event.country, AE_BLOB_MAX_BYTES) ?? 'unknown'
    const device = requiredString(event.device, AE_BLOB_MAX_BYTES) ?? 'unknown'
    const browser = requiredString(event.browser, AE_BLOB_MAX_BYTES) ?? 'unknown'
    const userId = typeof event.userId === 'string' ? event.userId : ''
    const errorCode = typeof event.errorCode === 'string' ? event.errorCode : ''
    if (!organizationId || !name || !videoId || !sessionId) continue
    if (utf8Bytes(userId) > AE_BLOB_MAX_BYTES || utf8Bytes(errorCode) > AE_BLOB_MAX_BYTES) continue
    if (
      !isFiniteNumber(event.watchedDelta) ||
      !isFiniteNumber(event.currentTime) ||
      !isFiniteNumber(event.duration)
    ) {
      continue
    }
    const row: PlaybackIngestRow = {
      event: name,
      videoId,
      sessionId,
      userId,
      country,
      device,
      browser,
      errorCode,
      watchedDelta: event.watchedDelta,
      currentTime: event.currentTime,
      duration: event.duration,
      organizationId,
    }
    if (combinedBlobsBytes(playbackDataPoint(row).blobs) > AE_BLOBS_TOTAL_MAX_BYTES) continue
    rows.push(row)
  }
  return rows
}

export type IngestResult =
  | { status: 200; body: { accepted: number } }
  | { status: 401; body: { error: string } }
  | { status: 400; body: { error: string } }
  | { status: 405; body: { error: string } }
  | { status: 503; body: { error: string } }

export function authorizeIngest(request: Request, env: IngestEnv): boolean {
  const expected = env.ANALYTICS_INGEST_SECRET?.trim() ?? ''
  if (!expected) return false
  const got =
    request.headers.get('x-analytics-ingest-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    ''
  return got.length > 0 && secretsMatch(got, expected)
}

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel()
  } catch {
    // Already locked or consumed.
  }
}

export type LimitedJson =
  | { ok: true; value: unknown }
  | { ok: false; status: 413 | 400; error: string }

export async function readJsonWithLimit(request: Request, maxBytes: number): Promise<LimitedJson> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      await cancelBody(request)
      return { ok: false, status: 413, error: 'Payload too large' }
    }
  }

  const reader = request.body?.getReader()
  if (!reader) {
    return { ok: false, status: 400, error: 'Malformed payload' }
  }

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
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  } catch {
    return { ok: false, status: 400, error: 'Malformed payload' }
  }
}

export async function handlePlaybackIngestRequest(request: Request, env: IngestEnv): Promise<Response> {
  if (request.method !== 'POST') {
    await cancelBody(request)
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }
  if (!authorizeIngest(request, env)) {
    await cancelBody(request)
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const limited = await readJsonWithLimit(request, INGEST_MAX_BODY_BYTES)
  if (!limited.ok) {
    return Response.json({ error: limited.error }, { status: limited.status })
  }
  const result = ingestPlaybackEvents({
    method: 'POST',
    authorized: true,
    body: limited.value,
    env,
  })
  return Response.json(result.body, { status: result.status })
}

export function ingestPlaybackEvents(input: {
  method: string
  authorized: boolean
  body: unknown
  env: IngestEnv
}): IngestResult {
  if (input.method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed' } }
  }
  if (!input.authorized) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }
  if (!analyticsEnabled(input.env)) {
    return { status: 503, body: { error: 'Analytics disabled' } }
  }
  if (!input.env.PLAYBACK_ANALYTICS) {
    return { status: 503, body: { error: 'Playback analytics binding unavailable' } }
  }
  const rows = parseIngestRows(input.body)
  if (rows === null) {
    return { status: 400, body: { error: 'Malformed payload: expected { events: [...] }' } }
  }
  const toWrite = rows.slice(0, WAE_MAX_DATA_POINTS_PER_INVOCATION)
  for (const row of toWrite) {
    input.env.PLAYBACK_ANALYTICS.writeDataPoint(playbackDataPoint(row))
  }
  return { status: 200, body: { accepted: toWrite.length } }
}

export function deliveryAnalyticsCapabilities(env: IngestEnv): {
  analyticsEnabled: boolean
  playbackWrite: 'analytics-engine' | 'none'
  bandwidthWrite: 'analytics-engine' | 'none'
  ingestConfigured: boolean
} {
  const enabled = analyticsEnabled(env)
  return {
    analyticsEnabled: enabled,
    playbackWrite: enabled && env.PLAYBACK_ANALYTICS ? 'analytics-engine' : 'none',
    bandwidthWrite: enabled && env.USAGE_ANALYTICS ? 'analytics-engine' : 'none',
    ingestConfigured: Boolean(env.ANALYTICS_INGEST_SECRET?.trim()),
  }
}
