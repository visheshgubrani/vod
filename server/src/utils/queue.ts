import type { Bindings } from '../types'

/**
 * Transcoding job dispatcher (deep module).
 *
 * One small interface — `triggerTranscoding(...)` — with two adapters behind
 * it:
 * - direct HTTP: POST to the user's Modal endpoint with bounded retries
 *   (default; works without any queue vendor)
 * - QStash: when QSTASH_TOKEN is configured (optional adapter)
 *
 * Failure semantics: `triggerTranscoding` THROWS a typed `DispatchError` on
 * final failure. Callers must only move a video to `processing` AFTER the
 * dispatch is accepted — otherwise a failed dispatch silently strands videos
 * in `processing` forever.
 */

export type DispatchPayload = {
  key: string
  bucket: string
  fileId: string
  playbackPolicy: 'public' | 'signed'
  generateSubtitle: boolean
  generateChapters: boolean
  organizationId: string
  callbackUrl: string
  /** Transcoder liveness endpoint derived from the callback URL. */
  heartbeatUrl?: string
  /**
   * Attempt id that owns this row (see `lib/transcodeClaim.ts`).
   *
   * The transcoder must (a) suppress a repeat delivery of the same attempt id
   * and (b) echo it on every callback and heartbeat, so a stalled attempt's
   * callback cannot mutate a row that a newer attempt now owns.
   */
  attemptId: string
}

export type DispatchErrorCode =
  | 'CONFIG_MISSING'
  | 'HTTP_STATUS'
  | 'ENVELOPE_ERROR'
  | 'NETWORK'
  | 'QUEUE_ERROR'

export class DispatchError extends Error {
  readonly code: DispatchErrorCode
  /**
   * HTTP status, when the failure was a response. Carried so callers can tell a
   * definitive rejection (4xx — the request arrived and was refused) from an
   * ambiguous one (5xx/timeout — it may have been accepted).
   */
  readonly status?: number

  constructor(code: DispatchErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'DispatchError'
    this.code = code
    this.status = status
  }
}

/**
 * Did this failure leave the dispatch outcome unknown?
 *
 * The transcoder endpoint *starts work* when it accepts a request. So a network
 * error, a timeout, or a 5xx may mean the job is running even though we never
 * saw a response. Treating that as "failed" is wrong twice over: it marks a
 * live job failed, and it hides the job from reconciliation. The correct move
 * is to keep the attempt claim and let its lease expire, so the sweeper
 * reconciles against the attempt id it actually observed.
 *
 * A 4xx is different: the request definitely arrived and was definitely
 * refused, so nothing is running.
 */
export function isUncertainDispatch(error: DispatchError): boolean {
  if (error.code === 'CONFIG_MISSING' || error.code === 'ENVELOPE_ERROR') {
    return false
  }
  if (
    error.code === 'HTTP_STATUS' &&
    error.status != null &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return false
  }
  return true
}

export type DispatchEnv = {
  QSTASH_TOKEN?: string
  TRANSCODE_INGEST_SECRET?: string
  MODAL_WEBHOOK_SECRET?: string
  MODAL_WEBHOOK_URL?: string
  RAW_BUCKET_NAME?: string
  BACKEND_URL?: string
}

export interface DirectHttpDeps {
  fetchImpl: typeof fetch
  sleep: (ms: number) => Promise<void>
  jitter: () => number
}

const DIRECT_RETRIES = 5
const DIRECT_TIMEOUT_MS = 15_000
const BACKOFF_BASE_MS = 500

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const defaultJitter = () => Math.random() * 300

const defaultDeps: DirectHttpDeps = {
  fetchImpl: fetch,
  sleep: defaultSleep,
  jitter: defaultJitter,
}

/** Which adapter should be used for the given environment? */
export function pickDispatcher(env: DispatchEnv): 'qstash' | 'direct' {
  if (env.QSTASH_TOKEN) return 'qstash'
  return 'direct'
}

function resolveEnv(env?: Bindings): DispatchEnv {
  const processEnv = typeof process !== 'undefined' ? process.env : {}
  const merged: DispatchEnv = { ...(processEnv as DispatchEnv), ...(env as DispatchEnv) }
  return merged
}

function buildCallbackUrl(backendUrl: string | undefined): string {
  const raw = backendUrl || 'http://localhost:8787'
  const clean = raw.replace(/\/+$/, '')
  const baseUrl = clean.endsWith('/api') ? clean.slice(0, -4) : clean
  return `${baseUrl}/api/webhook/transcode-complete`
}

/**
 * Direct HTTP adapter: POST the transcode payload to the Modal endpoint.
 * Retries transient failures (network errors, 429, 5xx) with exponential
 * backoff + jitter; never retries other 4xx responses. Throws DispatchError.
 */
export async function dispatchDirectHttp(
  input: {
    url: string
    ingestSecret: string
    payload: DispatchPayload
  },
  deps: DirectHttpDeps = defaultDeps,
): Promise<void> {
  const { url, ingestSecret, payload } = input
  if (!url || !/^https?:\/\//.test(url)) {
    throw new DispatchError(
      'CONFIG_MISSING',
      'Modal webhook URL is not configured (MODAL_WEBHOOK_URL)',
    )
  }
  if (!ingestSecret) {
    throw new DispatchError(
      'CONFIG_MISSING',
      'Transcode ingest secret is not configured (TRANSCODE_INGEST_SECRET or MODAL_WEBHOOK_SECRET)',
    )
  }

  let lastError: DispatchError | null = null
  let attempt = 0

  while (attempt <= DIRECT_RETRIES) {
    const shouldRetry = attempt < DIRECT_RETRIES

    // Network-level failures (DNS, TCP, timeout) — retry.
    let response: Response
    try {
      response = await deps.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ingestSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
      })
    } catch (err) {
      lastError = new DispatchError(
        'NETWORK',
        `Failed to reach transcoder: ${err instanceof Error ? err.message : String(err)}`,
      )
      if (!shouldRetry) throw lastError
      await deps.sleep(BACKOFF_BASE_MS * 2 ** attempt + deps.jitter())
      attempt += 1
      continue
    }

    // Application-level responses.
    if (response.ok) {
      const text = await response.text()
      let envelope: { status?: string; message?: string } | null = null
      try {
        envelope = text ? JSON.parse(text) : null
      } catch {
        throw new DispatchError('ENVELOPE_ERROR', 'Transcoder returned invalid JSON')
      }
      if (envelope?.status === 'error') {
        throw new DispatchError(
          'ENVELOPE_ERROR',
          `Transcoder rejected the job: ${envelope.message ?? 'unknown reason'}`,
        )
      }
      // 2xx with an accepted/no status envelope counts as dispatched.
      return
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      // Client rejection — retrying will not help.
      throw new DispatchError(
        'HTTP_STATUS',
        `Transcoder rejected the request with HTTP ${response.status}`,
      )
    }

    // 429 / 5xx — transient, retry with backoff.
    lastError = new DispatchError(
      'HTTP_STATUS',
      `Transcoder responded with HTTP ${response.status}`,
      response.status,
    )
    if (!shouldRetry) throw lastError
    await deps.sleep(BACKOFF_BASE_MS * 2 ** attempt + deps.jitter())
    attempt += 1
  }

  throw lastError ?? new DispatchError('NETWORK', 'Transcoding dispatch failed')
}

/**
 * A transcode dispatch request.
 *
 * An options object rather than positional arguments specifically so that
 * `attemptId` cannot be omitted: dispatching without naming the attempt that
 * owns the row is the bug this field exists to prevent.
 */
export type TranscodeDispatchRequest = {
  key: string
  fileId: string
  organizationId: string
  attemptId: string
  playbackPolicy?: 'public' | 'signed'
  generateSubtitle?: boolean
  generateChapters?: boolean
  env?: Bindings
}

/**
 * Queue a transcode job. Resolves once the job is accepted by the backend;
 * throws a typed `DispatchError` on final failure (missing config, HTTP
 * rejection after retries, queue errors).
 *
 * Callers must hold the attempt claim before calling this — see
 * `utils/dispatchTranscode.ts`, which packages claim + dispatch + failure
 * handling so no call site can dispatch an unowned job.
 */
export async function triggerTranscoding(
  request: TranscodeDispatchRequest,
): Promise<void> {
  const {
    key: fileKey,
    fileId,
    organizationId,
    attemptId,
    playbackPolicy = 'public',
    generateSubtitle = false,
    generateChapters = false,
    env,
  } = request

  const envMap = resolveEnv(env)

  const ingestSecret = envMap.TRANSCODE_INGEST_SECRET ?? envMap.MODAL_WEBHOOK_SECRET
  if (!ingestSecret) {
    throw new DispatchError(
      'CONFIG_MISSING',
      'TRANSCODE_INGEST_SECRET (or MODAL_WEBHOOK_SECRET) is not set',
    )
  }

  const modalWebhookUrl = envMap.MODAL_WEBHOOK_URL
  if (!modalWebhookUrl) {
    throw new DispatchError('CONFIG_MISSING', 'MODAL_WEBHOOK_URL is not set')
  }

  const rawBucketName = envMap.RAW_BUCKET_NAME
  if (!rawBucketName) {
    throw new DispatchError(
      'CONFIG_MISSING',
      'RAW_BUCKET_NAME is not set (raw ingest bucket)',
    )
  }

  const callbackUrl = buildCallbackUrl(envMap.BACKEND_URL)
  const payload: DispatchPayload = {
    key: fileKey,
    bucket: rawBucketName,
    fileId,
    playbackPolicy,
    generateSubtitle,
    generateChapters,
    organizationId,
    callbackUrl,
    heartbeatUrl: callbackUrl.replace(
      '/api/webhook/transcode-complete',
      '/api/webhook/heartbeat',
    ),
    attemptId,
  }

  const adapter = pickDispatcher(envMap)
  if (adapter === 'qstash') {
    const { Client } = await import('@upstash/qstash')
    try {
      const client = new Client({ token: envMap.QSTASH_TOKEN! })
      await client.publishJSON({
        url: modalWebhookUrl,
        body: payload,
        headers: {
          Authorization: `Bearer ${ingestSecret}`,
        },
        retries: 3,
      })
      return
    } catch (error) {
      throw new DispatchError(
        'QUEUE_ERROR',
        `QStash publish failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  await dispatchDirectHttp({ url: modalWebhookUrl, ingestSecret, payload })
}
