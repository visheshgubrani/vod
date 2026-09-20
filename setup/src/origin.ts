/**
 * Public origin for a host install: one hostname the operator (and Caddy)
 * will serve, from which every API/dashboard/CORS URL is derived.
 *
 * Host installs offer `http://localhost` or a public HTTPS hostname. Anything
 * else — credentials, a path, a query, a custom port — is a different
 * installation than the one Caddy will bind, so it is rejected here rather
 * than written into `.env` and discovered after the stack is up.
 */

export type PublicAccess = 'localhost' | 'domain'

export interface ParsedOrigin {
  origin: string
  access: PublicAccess
}

export type OriginParse = { ok: true } & ParsedOrigin | { ok: false; error: string }

/**
 * URLs derived from a single origin. `/api` and `/api/auth` stay on the
 * suffixes the dashboard and better-auth already require; the origin itself
 * is the API, the auth base, and the frontend.
 */
export interface OriginUrls {
  origin: string
  api: string
  frontend: string
  nextApi: string
  nextAuth: string
  cors: string
}

export interface DeploymentProxyAnswers {
  enabled: boolean
  /** Caddy site address: `http://localhost` or a bare public hostname. */
  site: string
  acmeEmail?: string
  /** Compose published-port bind address (`127.0.0.1` or `0.0.0.0`). */
  bindAddress: string
  /** Compose `COMPOSE_PROFILES` value (`proxy`, later `proxy,transcoder`). */
  profiles: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function looksLikeBareHost(value: string): boolean {
  if (value.includes('://') || value.includes('/') || value.includes('?')) return false
  if (value.includes('@')) return false
  return /^[A-Za-z0-9][A-Za-z0-9.-]+[A-Za-z0-9]$/.test(value) || value === 'localhost'
}

/**
 * Normalize a typed origin. Bare hostnames are treated as `https://<host>`.
 * Localhost is always `http://localhost` (loopback HTTP via Caddy).
 */
export function parsePublicOrigin(raw: string): OriginParse {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { ok: false, error: 'origin is required' }
  }

  let url: URL
  try {
    url = new URL(looksLikeBareHost(trimmed) ? `https://${trimmed}` : trimmed)
  } catch {
    return { ok: false, error: 'must be an http(s) origin or a hostname' }
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'must not include credentials' }
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { ok: false, error: 'must not include a path' }
  }
  if (url.search !== '') {
    return { ok: false, error: 'must not include a query' }
  }
  if (url.hash !== '') {
    return { ok: false, error: 'must not include a fragment' }
  }
  if (url.port !== '') {
    return { ok: false, error: 'must not include a custom port' }
  }

  const host = url.hostname.toLowerCase()
  if (LOCAL_HOSTS.has(host)) {
    if (url.protocol !== 'http:') {
      return { ok: false, error: 'localhost installations use http://localhost' }
    }
    return { ok: true, origin: 'http://localhost', access: 'localhost' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'public hostnames must use https' }
  }

  return { ok: true, origin: `https://${host}`, access: 'domain' }
}

/** Every public URL the deploy `.env` needs, from one origin. */
export function urlsFromOrigin(origin: string): OriginUrls {
  const base = origin.replace(/\/+$/, '')
  return {
    origin: base,
    api: base,
    frontend: base,
    nextApi: `${base}/api`,
    nextAuth: `${base}/api/auth`,
    cors: base,
  }
}

export function proxySettingsFor(
  parsed: ParsedOrigin,
  acmeEmail?: string,
): DeploymentProxyAnswers {
  if (parsed.access === 'localhost') {
    return {
      enabled: true,
      site: 'http://localhost',
      bindAddress: '127.0.0.1',
      profiles: 'proxy',
    }
  }
  const hostname = new URL(parsed.origin).hostname
  return {
    enabled: true,
    site: hostname,
    ...(acmeEmail !== undefined && acmeEmail.trim() !== ''
      ? { acmeEmail: acmeEmail.trim() }
      : {}),
    bindAddress: '0.0.0.0',
    profiles: 'proxy',
  }
}
