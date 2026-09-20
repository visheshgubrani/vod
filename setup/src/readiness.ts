/**
 * Strict host-install readiness: the configured origin must serve the
 * dashboard and a ready API `/health/config`. The ordinary deploy probe is
 * warn-only; this one is what makes an installation complete or not.
 */

export interface OriginReadyInput {
  origin: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  delayMs?: number
}

export type OriginReadyFailure =
  | { kind: 'http'; url: string; status: number }
  | { kind: 'invalid'; url: string; detail: string }
  | { kind: 'not-ready'; problems: string[] }
  | { kind: 'checks'; failed: string[] }
  | { kind: 'network'; url: string; detail: string }

export class OriginReadyError extends Error {
  readonly failure: OriginReadyFailure

  constructor(failure: OriginReadyFailure) {
    super(describeOriginFailure(failure))
    this.name = 'OriginReadyError'
    this.failure = failure
  }
}

export function describeOriginFailure(failure: OriginReadyFailure): string {
  switch (failure.kind) {
    case 'http':
      return `GET ${failure.url} returned HTTP ${failure.status}`
    case 'invalid':
      return `GET ${failure.url} was not a usable response (${failure.detail})`
    case 'not-ready':
      return `API reports ready: false${failure.problems.length > 0 ? ` — ${failure.problems.join('; ')}` : ''}`
    case 'checks':
      return `API configuration checks failed: ${failure.failed.join(', ')}`
    case 'network':
      return `could not reach ${failure.url} (${failure.detail})`
  }
}

const DEFAULT_ATTEMPTS = 30
const DEFAULT_DELAY_MS = 2_000

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function probeOnce(
  origin: string,
  fetchImpl: typeof fetch,
): Promise<OriginReadyFailure | null> {
  const base = origin.replace(/\/+$/, '')
  const dashboardUrl = `${base}/`
  try {
    const dashboard = await fetchImpl(dashboardUrl, { signal: AbortSignal.timeout(10_000) })
    if (!dashboard.ok) {
      return { kind: 'http', url: dashboardUrl, status: dashboard.status }
    }
  } catch (error) {
    return {
      kind: 'network',
      url: dashboardUrl,
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const healthUrl = `${base}/health/config`
  let response: Response
  try {
    response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    return {
      kind: 'network',
      url: healthUrl,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (!response.ok) {
    return { kind: 'http', url: healthUrl, status: response.status }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'invalid', url: healthUrl, detail: 'body is not JSON' }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'invalid', url: healthUrl, detail: 'body is not an object' }
  }
  const record = body as {
    ready?: unknown
    problems?: unknown
    checks?: unknown
  }
  if (record.ready !== true) {
    const problems = Array.isArray(record.problems)
      ? record.problems.filter((item): item is string => typeof item === 'string')
      : []
    return { kind: 'not-ready', problems }
  }
  if (record.checks !== undefined && record.checks !== null && typeof record.checks === 'object') {
    const failed = Object.entries(record.checks as Record<string, unknown>)
      .filter(([, ok]) => ok === false)
      .map(([key]) => key)
    if (failed.length > 0) return { kind: 'checks', failed }
  }
  return null
}

/** Probe the origin, retrying until success or the attempt budget is spent. */
export async function waitForOriginReady(input: OriginReadyInput): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch
  const sleep = input.sleep ?? defaultSleep
  const attempts = input.attempts ?? DEFAULT_ATTEMPTS
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS
  const origin = input.origin.replace(/\/+$/, '')

  let last: OriginReadyFailure | null = {
    kind: 'network',
    url: `${origin}/health/config`,
    detail: 'not attempted',
  }
  for (let i = 0; i < attempts; i += 1) {
    last = await probeOnce(origin, fetchImpl)
    if (last === null) return
    if (i + 1 < attempts) await sleep(delayMs)
  }
  throw new OriginReadyError(last)
}
