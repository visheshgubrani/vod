/**
 * OpenVOD server configuration module.
 *
 * Deep module: callers learn one small interface (`loadConfig` + `matchOrigin`)
 * and never reach into raw `process.env`/binding maps for validation-sensitive
 * values. Centralizes the "what is configured for BYOK?" answer used by
 * /health/config, the setup wizard, CORS, and boot diagnostics.
 *
 * Design rules:
 * - Never throw. Returns capability flags + human-readable problems.
 * - Never coerce a missing secret into the string "undefined".
 * - No placeholder URLs (e.g. the old `delivery.example.com` fallback).
 */

export type EnvLike = Record<string, string | undefined>

export type CapabilityChecks = {
  database: boolean
  storage: boolean
  transcoder: boolean
  auth: boolean
  analytics: boolean
  ai: boolean
}

export type OpenVodConfig = {
  /** True when every CORE capability is configured (db/storage/transcoder/auth). */
  ready: boolean
  checks: CapabilityChecks
  /** Human-readable, non-secret problems ("DATABASE_URL is not set"). */
  problems: string[]
  /** Optional-capability notices (analytics/AI disabled) — not blockers. */
  advisories: string[]
  jwtSecret: string | null
  deliveryUrl: string | null
  modalWebhookUrl: string | null
  ingestSecret: string | null
  rawBucket: string | null
  transcodedBucket: string | null
}

const isHttpUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value)

function hasSecret(env: EnvLike, key: string): boolean {
  const value = env[key]
  return typeof value === 'string' && value.trim().length > 0
}

function secretValue(env: EnvLike, key: string): string | null {
  const value = env[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const MIN_SECRET_LENGTH = 32

export function loadConfig(env: EnvLike): OpenVodConfig {
  const problems: string[] = []
  const advisories: string[] = []

  // ---- database -----------------------------------------------------------
  const databaseUrl = secretValue(env, 'DATABASE_URL')
  if (!databaseUrl) {
    problems.push('DATABASE_URL is not set')
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a postgres:// or postgresql:// URL')
  }

  // ---- storage (R2 via S3 API) ----------------------------------------------
  const accountId = secretValue(env, 'ACCOUNT_ID')
  const r2AccessKey = secretValue(env, 'R2_ACCESS_KEY_ID')
  const r2SecretKey = secretValue(env, 'R2_SECRET_ACCESS_KEY')
  const rawBucket = secretValue(env, 'RAW_BUCKET_NAME')
  const transcodedBucket = secretValue(env, 'TRANSCODED_BUCKET_NAME')
  const storageConfigured =
    Boolean(accountId) && Boolean(r2AccessKey) && Boolean(r2SecretKey)
  if (!accountId) problems.push('ACCOUNT_ID is not set (Cloudflare account for R2)')
  if (!r2AccessKey) problems.push('R2_ACCESS_KEY_ID is not set')
  if (!r2SecretKey) problems.push('R2_SECRET_ACCESS_KEY is not set')
  if (!rawBucket) problems.push('RAW_BUCKET_NAME is not set')
  if (!transcodedBucket) problems.push('TRANSCODED_BUCKET_NAME is not set')

  // ---- transcoder (Modal webhook) -------------------------------------------
  const modalWebhookUrl = secretValue(env, 'MODAL_WEBHOOK_URL')
  const ingestSecret =
    secretValue(env, 'TRANSCODE_INGEST_SECRET') ?? secretValue(env, 'MODAL_WEBHOOK_SECRET')
  if (!modalWebhookUrl) {
    problems.push('MODAL_WEBHOOK_URL is not set')
  } else if (!isHttpUrl(modalWebhookUrl)) {
    problems.push('MODAL_WEBHOOK_URL must be an absolute http(s) URL')
  }
  if (!ingestSecret) {
    problems.push('TRANSCODE_INGEST_SECRET (or MODAL_WEBHOOK_SECRET) is not set')
  }

  // ---- auth (sessions + playback signing) -------------------------------------
  const betterAuthSecret = secretValue(env, 'BETTER_AUTH_SECRET')
  const jwtSecret = secretValue(env, 'JWT_SECRET')
  if (!betterAuthSecret) {
    problems.push('BETTER_AUTH_SECRET is not set')
  } else if (betterAuthSecret.length < MIN_SECRET_LENGTH) {
    problems.push('BETTER_AUTH_SECRET must be at least 32 characters')
  }
  if (!jwtSecret) {
    problems.push('JWT_SECRET is not set')
  } else if (jwtSecret.length < MIN_SECRET_LENGTH) {
    problems.push('JWT_SECRET must be at least 32 characters')
  }

  // ---- analytics (Cloudflare Analytics Engine SQL API) --------------------------
  const analyticsToken = secretValue(env, 'CLOUDFLARE_ANALYTICS_TOKEN')
  if (!accountId || !analyticsToken) {
    advisories.push('CLOUDFLARE_ANALYTICS_TOKEN is not set (playback/bandwidth stats disabled)')
  }

  // ---- AI (optional) -------------------------------------------------------------
  const groqKey = secretValue(env, 'GROQ_API_KEY')
  if (!groqKey) {
    advisories.push('GROQ_API_KEY is not set (AI subtitles/chapters disabled)')
  }

  // ---- delivery base URL (never a placeholder) -----------------------------------
  let deliveryUrl: string | null = null
  const rawDeliveryUrl = secretValue(env, 'DELIVERY_URL') ?? secretValue(env, 'DELIVERY_WORKER_URL')
  if (rawDeliveryUrl) {
    const normalized = rawDeliveryUrl.replace(/\/+$/, '')
    if (isHttpUrl(normalized)) {
      deliveryUrl = normalized
    } else {
      problems.push('DELIVERY_URL must be an absolute http(s) URL (no placeholder allowed)')
    }
  }

  return {
    ready: problems.length === 0,
    checks: {
      database: Boolean(databaseUrl && /^postgres(ql)?:\/\//.test(databaseUrl)),
      storage: storageConfigured && Boolean(rawBucket) && Boolean(transcodedBucket),
      transcoder: Boolean(modalWebhookUrl && ingestSecret && isHttpUrl(modalWebhookUrl)),
      auth: Boolean(
        betterAuthSecret &&
          betterAuthSecret.length >= MIN_SECRET_LENGTH &&
          jwtSecret &&
          jwtSecret.length >= MIN_SECRET_LENGTH,
      ),
      analytics: Boolean(accountId && analyticsToken),
      ai: Boolean(groqKey),
    },
    problems,
    advisories,
    jwtSecret: jwtSecret && jwtSecret.length >= MIN_SECRET_LENGTH ? jwtSecret : null,
    deliveryUrl,
    modalWebhookUrl: modalWebhookUrl && isHttpUrl(modalWebhookUrl) ? modalWebhookUrl : null,
    ingestSecret,
    rawBucket,
    transcodedBucket,
  }
}

/** Parse a comma-separated origin list (FRONTEND_URL / CORS_ORIGINS). */
export function parseOriginList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

/**
 * Fail-closed accessor for the playback JWT secret.
 * Throws when unset/short — callers must never sign with `"undefined"`.
 */
export function requirePlaybackJwtSecret(env?: EnvLike): string {
  const merged: EnvLike = {
    ...(typeof process !== 'undefined' ? (process.env as EnvLike) : {}),
    ...(env ?? {}),
  }
  const secret = loadConfig(merged).jwtSecret
  if (!secret) {
    throw new Error('JWT_SECRET is not configured (must be at least 32 characters)')
  }
  return secret
}

/**
 * Delivery base URL or null. Never a placeholder: unconfigured returns null
 * so callers emit relative URLs instead of fake absolute ones.
 */
export function readDeliveryBaseUrl(env?: EnvLike): string | null {
  const merged: EnvLike = {
    ...(typeof process !== 'undefined' ? (process.env as EnvLike) : {}),
    ...(env ?? {}),
  }
  return loadConfig(merged).deliveryUrl
}

/**
 * Match a browser `Origin` header against configured patterns.
 *
 * Supported pattern forms (lower-cased, trimmed):
 * - exact origin:        `https://app.example.com`
 * - bare hostname:       `app.example.com`
 * - wildcard subdomains: `*.vercel.app`   (matches foo.vercel.app, NOT the apex)
 * - allow-all:           `*`
 *
 * Ports and schemes are ignored for hostname/wildcard comparisons; exact
 * patterns must match the full origin string.
 */
export function matchOrigin(origin: string | null | undefined, patterns: string[]): boolean {
  if (!origin || typeof origin !== 'string') return false
  const originLower = origin.trim().toLowerCase()
  if (!originLower) return false
  const originHost = hostnameOf(originLower)
  if (!originHost) return false

  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) continue
    if (pattern === '*') return true
    if (pattern === originLower) return true

    if (pattern.startsWith('*.')) {
      const base = stripScheme(pattern).slice(2)
      if (originHost.endsWith(`.${base}`)) return true
      continue
    }

    const patternHost = hostnameOf(pattern) ?? hostnameOf(stripScheme(pattern))
    if (patternHost && patternHost === originHost) return true
  }

  return false
}

function stripScheme(value: string): string {
  const idx = value.indexOf('://')
  return idx === -1 ? value : value.slice(idx + 3)
}

function hostnameOf(value: string): string | null {
  const withoutScheme = stripScheme(value)
  // Strip a path if present (e.g. https://x/y -> x)
  const pathless = withoutScheme.split(/[/?#]/)[0]
  const hostPort = pathless.split('@').pop() ?? ''
  const host = hostPort.split(':')[0]
  if (!host) return null
  return host.includes('.') || host === 'localhost' ? host : null
}
