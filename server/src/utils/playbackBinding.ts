import { createHash } from 'node:crypto'

export type PlaybackBindingClaims = {
  ip_hash: string
  ua_hash: string
}

const UNKNOWN_IP = 'unknown'
const UNKNOWN_USER_AGENT = 'unknown'

function firstForwardedValue(value: string): string {
  const [first = ''] = value.split(',')
  return first.trim()
}

function stripIpPort(value: string): string {
  const ipv4WithPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (ipv4WithPort?.[1]) return ipv4WithPort[1]

  const bracketedIpv6 = value.match(/^\[([a-f0-9:.%]+)\](?::\d+)?$/i)
  if (bracketedIpv6?.[1]) return bracketedIpv6[1]

  return value
}

export function normalizePlaybackIp(value: string | null | undefined): string {
  if (!value) return UNKNOWN_IP

  let normalized = firstForwardedValue(value)
  if (!normalized) return UNKNOWN_IP

  normalized = stripIpPort(normalized).trim().toLowerCase()
  if (!normalized) return UNKNOWN_IP

  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice('::ffff:'.length)
  }

  return normalized || UNKNOWN_IP
}

export function normalizePlaybackUserAgent(value: string | null | undefined): string {
  if (!value) return UNKNOWN_USER_AGENT

  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase()
  return normalized || UNKNOWN_USER_AGENT
}

function isPrivateOrLocalIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true
  }

  const [a, b] = parts

  // Common non-public IPv4 ranges.
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function isPrivateOrLocalIpv6(value: string): boolean {
  const ip = value.split('%')[0] || value

  // Loopback, unspecified, unique-local and link-local.
  return (
    ip === '::1' ||
    ip === '0:0:0:0:0:0:0:1' ||
    ip === '::' ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('fe8') ||
    ip.startsWith('fe9') ||
    ip.startsWith('fea') ||
    ip.startsWith('feb')
  )
}

export function isPublicPlaybackIp(value: string | null | undefined): boolean {
  const normalized = normalizePlaybackIp(value)

  if (normalized === UNKNOWN_IP || normalized === 'localhost') {
    return false
  }

  if (normalized.includes(':')) {
    return !isPrivateOrLocalIpv6(normalized)
  }

  return !isPrivateOrLocalIpv4(normalized)
}

function hashPlaybackValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildPlaybackBindingClaims(
  ip: string | null | undefined,
  userAgent: string | null | undefined,
): PlaybackBindingClaims {
  const normalizedIp = normalizePlaybackIp(ip)
  const normalizedUserAgent = normalizePlaybackUserAgent(userAgent)

  return {
    ip_hash: hashPlaybackValue(normalizedIp),
    ua_hash: hashPlaybackValue(normalizedUserAgent),
  }
}

export function getClientIpFromHeaders(headers: Headers): string | null {
  return (
    headers.get('cf-connecting-ip') ||
    headers.get('x-forwarded-for') ||
    headers.get('x-real-ip') ||
    headers.get('x-client-ip')
  )
}

export function getUserAgentFromHeaders(headers: Headers): string | null {
  return headers.get('user-agent')
}
