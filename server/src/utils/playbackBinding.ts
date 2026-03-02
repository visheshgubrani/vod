import { createHash } from 'node:crypto'

export type PlaybackBindingClaims = {
  ua_hash: string
}

const UNKNOWN_USER_AGENT = 'unknown'

export function normalizePlaybackUserAgent(value: string | null | undefined): string {
  if (!value) return UNKNOWN_USER_AGENT

  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!normalized) return UNKNOWN_USER_AGENT

  // Normalize to browser engine/family so minor version updates don't break playback.
  if (normalized.includes('applecoremedia')) return 'applecoremedia'
  if (normalized.includes('edg/') || normalized.includes('edga/') || normalized.includes('edgios/')) {
    return 'edge'
  }
  if (normalized.includes('opr/') || normalized.includes('opera')) return 'opera'
  if (
    normalized.includes('chrome/') ||
    normalized.includes('crios/') ||
    normalized.includes('chromium/') ||
    normalized.includes('crmo/')
  ) {
    return 'chrome'
  }
  if (normalized.includes('firefox/') || normalized.includes('fxios/')) return 'firefox'
  if (normalized.includes('safari/')) return 'safari'
  if (normalized.includes('webkit/')) return 'webkit'
  if (normalized.includes('gecko/')) return 'gecko'

  return UNKNOWN_USER_AGENT
}

function hashPlaybackValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildPlaybackBindingClaims(
  userAgent: string | null | undefined,
): PlaybackBindingClaims {
  const normalizedUserAgent = normalizePlaybackUserAgent(userAgent)

  return {
    ua_hash: hashPlaybackValue(normalizedUserAgent),
  }
}

export function getUserAgentFromHeaders(headers: Headers): string | null {
  return headers.get('user-agent')
}
