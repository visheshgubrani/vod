/**
 * Pure text parsers for CLI tool output (ported from the retired
 * scripts/lib/openvod_setup.py). No I/O, no secret handling.
 */

const ACCOUNT_ID_RE = /\b[0-9a-f]{32}\b/i
const WORKERS_URL_RE = /https:\/\/[a-z0-9._-]+\.workers\.dev/gi
const MODAL_URL_RE = /https:\/\/[^\s]+modal\.run[^\s]*/gi

/** Cloudflare's pre-filled token form for the optional analytics read token. */
export function analyticsTokenTemplateUrl(): string {
  return 'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=OpenVOD%20Analytics'
}

/** First 32-hex id in `wrangler whoami` output, or null. */
export function parseAccountId(text: string): string | null {
  const match = text.match(ACCOUNT_ID_RE)
  return match ? match[0].toLowerCase() : null
}

/** Last *.workers.dev URL in deploy output, trailing slashes stripped. */
export function parseWorkersUrl(text: string): string | null {
  const urls = text.match(WORKERS_URL_RE)
  if (!urls || urls.length === 0) return null
  return urls[urls.length - 1].replace(/\/+$/, '')
}

/**
 * First Modal HTTPS URL in deploy output, preferring one whose host mentions
 * "transcode". Trailing punctuation and slashes are stripped.
 */
export function parseModalUrl(text: string): string | null {
  const urls = (text.match(MODAL_URL_RE) ?? []).map((url) =>
    url.replace(/[).,;:]+$/, '').replace(/\/+$/, ''),
  )
  if (urls.length === 0) return null
  const preferred = urls.find((url) => url.toLowerCase().includes('transcode'))
  return preferred ?? urls[0]
}

/** Image id from `Image build for im-… failed`, or null. */
export function parseModalImageId(text: string): string | null {
  const match = /\bim-[A-Za-z0-9]+\b/.exec(text)
  return match ? match[0] : null
}

/**
 * Outcome of a Modal auth probe.
 *
 * Three outcomes, because collapsing the last two is the bug that broke every
 * fresh install: `modal profile current` prints the *default profile name* and
 * exits 0 even with no token at all, so anything short of "exit 0 from
 * `token info`" must never be reported as authenticated. A probe that cannot
 * tell (timeout, spawn failure, unrecognised error) is `unverified` — the
 * caller asks, instead of assuming either way.
 */
export type ModalAuthState = 'authenticated' | 'unauthenticated' | 'unverified'

export interface ModalAuthProbe {
  code: number | null
  /** Combined stdout + stderr. Inspected only — never printed (it holds the token). */
  output?: string
  timedOut?: boolean
}

/**
 * What the CLI says when the credentials are missing or rejected.
 *
 * Matched case-insensitively against the probe output. Modal 1.5.x prints
 * "Token missing. Could not authenticate client."; the rest cover the variants
 * a rejected or revoked token produces. Anything else is `unverified` on
 * purpose: guessing "authenticated" here is what made `modal secret create`
 * fail after a login the wizard believed had already happened.
 */
const MODAL_AUTH_FAILURE_MARKERS = [
  'token missing',
  'could not authenticate',
  'not authenticated',
  'no token',
  'token is not set',
  'invalid token',
  'unauthorized',
  'authentication failed',
] as const

export function modalAuthState(probe: ModalAuthProbe): ModalAuthState {
  if (probe.timedOut === true || probe.code === null) return 'unverified'
  if (probe.code === 0) return 'authenticated'
  const text = (probe.output ?? '').toLowerCase()
  return MODAL_AUTH_FAILURE_MARKERS.some((marker) => text.includes(marker))
    ? 'unauthenticated'
    : 'unverified'
}

/**
 * Workspace name from `modal token info`, or null.
 *
 * The same output prints the token itself, so this is the *only* value read out
 * of it; callers never log the captured text.
 */
export function parseModalWorkspace(text: string): string | null {
  const match = /^\s*workspace:\s*(.+)$/im.exec(text)
  if (!match) return null
  const name = match[1].split('(')[0].trim()
  return name === '' ? null : name
}

/** Minimum Modal CLI the wizard drives — the version `requirements-deploy.txt` pins. */
export const MODAL_MIN_VERSION = '1.5.0'

/** `modal --version` → "1.5.5" (it prints "modal client version: 1.5.5"). */
export function parseModalClientVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

/** True when `actual` is at least `minimum` (both dotted numeric). */
export function versionAtLeast(actual: string | null, minimum: string): boolean {
  if (actual === null) return false
  const parse = (value: string): number[] =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(actual)
  const b = parse(minimum)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

function secretNameFromUnknown(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of ['label', 'name', 'secret_name']) {
    const field = record[key]
    if (typeof field === 'string' && field.trim() !== '') return field.trim()
  }
  return null
}

/**
 * Names from `modal secret list` stdout. Prefers JSON (`--json`); falls back
 * to the first column of a Unicode table when JSON is unavailable.
 */
export function parseModalSecretNames(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const items = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { secrets?: unknown }).secrets)
          ? (parsed as { secrets: unknown[] }).secrets
          : []
      const names: string[] = []
      for (const item of items) {
        const name = secretNameFromUnknown(item)
        if (name) names.push(name)
      }
      return names
    } catch {
      // fall through to table parsing
    }
  }
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[│|]\s*([A-Za-z0-9._-]+)\s*[│|]/.exec(line)
    if (!match) continue
    const name = match[1]
    if (name.toLowerCase() === 'name') continue
    names.push(name)
  }
  return names
}

/** True when `wrangler r2 bucket info` succeeded (exit 0). */
export function r2BucketAlreadyExists(code: number | null, _output: string): boolean {
  return code === 0
}
