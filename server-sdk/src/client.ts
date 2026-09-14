/**
 * The HTTP core.
 *
 * One place knows how to talk to the API: auth header, JSON, timeouts, error
 * mapping, request id, and which failures are worth retrying. Resources are
 * thin wrappers over `request()`.
 *
 * Retries are limited on purpose. Idempotent reads (GET) and the token-minting
 * endpoints retry on 429/5xx/network, because a duplicate token is harmless —
 * it just expires unused. Mutations (`PATCH`/`DELETE`) do not retry by default:
 * `DELETE` is idempotent server-side, but a blind retry of a timeout can hide
 * an outcome the caller needs to know.
 */

import {
    OpenVodError,
    codeForStatus,
    isRetryableCode,
    parseRetryAfter,
} from './errors'
import type { ListVideosParams, UpdateVideoParams } from './types'
import {
    createUploadToken,
    listVideos,
    updateVideo,
    deleteVideo,
    getVideo,
    type UploadsResource,
    type VideosResource,
    type PlaybackResource,
    createPlaybackToken,
} from './resources'

export interface OpenVodConfig {
    /** `sk_live_…` — server-side only. Never ship this to a browser. */
    apiKey: string
    /**
     * Origin of your OpenVOD API, without the `/v1` suffix
     * (`https://api.yourvod.com`). Required: there is no hosted default.
     */
    baseUrl: string
    /** Per-request timeout in ms (default 30 000). */
    timeoutMs?: number
    /** Retries for retryable failures (default 2, so 3 attempts total). */
    maxRetries?: number
    /** Injectable fetch — for tests, proxies, or a custom agent. */
    fetchImpl?: typeof fetch
}

interface RequestOptions {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    path: string
    body?: unknown
    query?: Record<string, string | number | undefined>
    /** Allow retrying this request on 429/5xx/network. */
    retryable?: boolean
}

/**
 * The OpenVOD API client.
 *
 * ```ts
 * const vod = new OpenVod({ apiKey: process.env.OPENVOD_API_KEY!, baseUrl: 'https://api.example.com' })
 * const { upload_token } = await vod.uploads.createToken({ expiresIn: '1h' })
 * ```
 */
export class OpenVod {
    private readonly apiKey: string
    private readonly baseUrl: string
    private readonly timeoutMs: number
    private readonly maxRetries: number
    private readonly fetchImpl: typeof fetch

    readonly uploads: UploadsResource
    readonly videos: VideosResource
    readonly playback: PlaybackResource

    constructor(config: OpenVodConfig) {
        if (!config?.apiKey) {
            throw new OpenVodError('apiKey is required', { code: 'UNAUTHORIZED' })
        }
        if (!config?.baseUrl) {
            throw new OpenVodError(
                'baseUrl is required — pass your deployment origin, e.g. https://api.example.com',
                { code: 'INVALID_REQUEST' },
            )
        }

        this.apiKey = config.apiKey
        this.baseUrl = config.baseUrl.replace(/\/+$/, '')
        this.timeoutMs = config.timeoutMs ?? 30_000
        this.maxRetries = Math.max(0, config.maxRetries ?? 2)
        this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args))

        this.uploads = {
            createToken: (params = {}) => createUploadToken(this, params),
        }
        this.videos = {
            get: (id) => getVideo(this, id),
            list: (params = {}) => listVideos(this, params),
            update: (id, patch) => updateVideo(this, id, patch),
            delete: (id) => deleteVideo(this, id),
        }
        this.playback = {
            createToken: (id, params = {}) => createPlaybackToken(this, id, params),
        }
    }

    /**
     * Perform an API request and parse its JSON.
     *
     * Exposed (rather than private) so an application can reach a route this
     * SDK does not model yet without dropping to raw `fetch` and losing the
     * auth, timeout and error handling.
     */
    async request<T>(options: RequestOptions): Promise<T> {
        const url = this.buildUrl(options.path, options.query)
        const isIdempotent = options.method === 'GET' || options.retryable === true
        let lastError: OpenVodError | null = null

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0 && lastError) {
                await sleep(backoffMs(lastError, attempt))
            }

            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), this.timeoutMs)

            let response: Response
            try {
                response = await this.fetchImpl(url, {
                    method: options.method,
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
                    signal: controller.signal,
                })
            } catch (cause) {
                const timedOut = controller.signal.aborted
                lastError = new OpenVodError(
                    timedOut
                        ? `Request timed out after ${this.timeoutMs}ms: ${options.method} ${options.path}`
                        : `Request failed: ${options.method} ${options.path} (${describe(cause)})`,
                    { code: timedOut ? 'TIMEOUT' : 'NETWORK', retryable: true, cause },
                )
                if (!isIdempotent) throw lastError
                continue
            } finally {
                clearTimeout(timer)
            }

            if (!response.ok) {
                const message = await readErrorMessage(response)
                const code = codeForStatus(response.status, message)
                lastError = new OpenVodError(message, {
                    code,
                    status: response.status,
                    requestId: response.headers.get('x-request-id') ?? undefined,
                    retryable: isRetryableCode(code),
                    retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
                })
                if (!isIdempotent || !lastError.retryable) throw lastError
                continue
            }

            try {
                return (await response.json()) as T
            } catch (cause) {
                throw new OpenVodError(
                    `Expected JSON from ${options.method} ${options.path}`,
                    { code: 'HTTP', status: response.status, cause },
                )
            }
        }

        throw lastError ?? new OpenVodError(`${options.method} ${options.path} failed`, {
            code: 'HTTP',
        })
    }

    private buildUrl(path: string, query?: RequestOptions['query']): string {
        const url = new URL(`${this.baseUrl}${path}`)
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined) url.searchParams.set(key, String(value))
        }
        return url.toString()
    }
}

/** Wait before the next attempt, honouring `Retry-After` when present. */
function backoffMs(error: OpenVodError, attempt: number): number {
    if (error.retryAfterMs !== undefined) return error.retryAfterMs
    const base = 250 * 2 ** (attempt - 1)
    // Jitter: a fleet of workers retrying the same 5xx must not re-collide.
    return Math.min(base + Math.floor(Math.random() * 100), 5_000)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function describe(value: unknown): string {
    if (value instanceof Error) {
        // AbortSignal.timeout and friends surface as "The operation was aborted".
        return value.name === 'AbortError' ? 'aborted' : value.message
    }
    return String(value)
}

/** Read the API's `{ error }` message, falling back to the status line. */
async function readErrorMessage(response: Response): Promise<string> {
    try {
        const data = (await response.json()) as { error?: unknown }
        if (data && typeof data.error === 'string' && data.error.trim()) return data.error
    } catch {
        // Non-JSON body — a proxy's HTML 502, an empty response, ...
    }
    return `${response.status} ${response.statusText}`.trim()
}

/**
 * Normalize list params into query values.
 *
 * Exported for the resource module and its tests: `limit` is clamped here
 * rather than silently forwarded, so a caller asking for 5000 gets 100 from the
 * SDK the same way the API would clamp it.
 */
export function listQuery(params: ListVideosParams): Record<string, string | number | undefined> {
    return {
        status: params.status,
        ...(params.limit !== undefined
            ? { limit: Math.max(1, Math.min(100, Math.floor(params.limit))) }
            : {}),
    }
}

/** Translate an update patch into the API's snake_case body. */
export function updateBody(patch: UpdateVideoParams): Record<string, unknown> {
    const body: Record<string, unknown> = {}
    if (patch.title !== undefined) body.title = patch.title
    if (patch.playbackPolicy !== undefined) body.playback_policy = patch.playbackPolicy
    return body
}
