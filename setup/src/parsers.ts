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

/** Exit codes and stdout from Modal CLI auth probes (no I/O). */
export interface ModalAuthProbes {
  tokenInfo: { code: number | null }
  profileCurrent?: { code: number | null; stdout: string }
}

/**
 * True when the Modal CLI reports an active token. `token info` exit 0 is
 * the current CLI; older CLIs fall back to a non-empty `profile current`.
 */
export function isModalCliAuthed(probes: ModalAuthProbes): boolean {
  if (probes.tokenInfo.code === 0) return true
  const profile = probes.profileCurrent
  return profile !== undefined && profile.code === 0 && profile.stdout.trim() !== ''
}

/** Active profile name from `modal profile current` stdout, or null. */
export function parseModalProfileName(stdout: string): string | null {
  const name = stdout.trim()
  return name === '' ? null : name.split(/\s+/)[0]
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
