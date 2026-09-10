/**
 * Pure text parsers for CLI tool output (ported from the retired
 * scripts/lib/openvod_setup.py). No I/O, no secret handling.
 */

const ACCOUNT_ID_RE = /\b[0-9a-f]{32}\b/i
const WORKERS_URL_RE = /https:\/\/[a-z0-9._-]+\.workers\.dev/gi
const MODAL_URL_RE = /https:\/\/[^\s]+modal\.run[^\s]*/gi

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
