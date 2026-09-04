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
}

export type DispatchErrorCode =
  | 'CONFIG_MISSING'
  | 'HTTP_STATUS'
  | 'ENVELOPE_ERROR'
  | 'NETWORK'
  | 'QUEUE_ERROR'

export class DispatchError extends Error {
  readonly code: DispatchErrorCode

  constructor(code: DispatchErrorCode, message: string) {
    super(message)
    this.name = 'DispatchError'
    this.code = code
  }
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
    )
    if (!shouldRetry) throw lastError
    await deps.sleep(BACKOFF_BASE_MS * 2 ** attempt + deps.jitter())
    attempt += 1
  }

  throw lastError ?? new DispatchError('NETWORK', 'Transcoding dispatch failed')
}

/**
 * Queue a transcode job. Resolves once the job is accepted by the backend;
 * throws a typed `DispatchError` on final failure (missing config, HTTP
 * rejection after retries, queue errors).
 */
export async function triggerTranscoding(
  fileKey: string,
  fileId: string,
  playbackPolicy: 'public' | 'signed' = 'public',
  generateSubtitle = false,
  generateChapters = false,
  organizationId: string,
  env?: Bindings,
): Promise<void> {
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
