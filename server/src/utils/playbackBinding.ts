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
