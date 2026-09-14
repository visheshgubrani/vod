/**
 * Pure mapping from wizard decisions to the env contract consumed by
 * server/.dev.vars and delivery/.dev.vars (see server/.dev.vars.example and
 * server/src/lib/config.ts). This module is the TDD seam: every decision a
 * user makes ends up here, so the mapping is exhaustively unit-tested.
 */

import type {
  DbAnswers,
  QueueAnswers,
  RateLimitAnswers,
  SecretSet,
  WizardAnswers,
} from './types'

/**
 * The dev Postgres URL for host-side tooling.
 *
 * This is what `pnpm dev:infra` (docker-compose.dev.yml) publishes on the host,
 * and what `pnpm dev`, migrations and tests all connect to. It is NOT a
 * deployment value: the deployment stack configures its own database through the
 * root `.env`.
 */
export const DEV_LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/vod_dev'

/** @deprecated Kept for older answer files and callers; use DEV_LOCAL_DATABASE_URL. */
export const COMPOSE_LOCAL_DATABASE_URL = DEV_LOCAL_DATABASE_URL

/** The dev Redis `pnpm dev:infra` publishes, for the `redis` rate-limit choice. */
export const DEV_LOCAL_REDIS_URL = 'redis://localhost:6382'

/** Canonical key order for server/.dev.vars (mirrors .dev.vars.example). */
export const SERVER_KEY_ORDER = [
  'DATABASE_URL',
  'DB_DRIVER',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'FRONTEND_URL',
  'CORS_ORIGINS',
  'BACKEND_URL',
  'ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'RAW_BUCKET_NAME',
  'TRANSCODED_BUCKET_NAME',
  'CLOUDFLARE_ANALYTICS_TOKEN',
  'QSTASH_TOKEN',
  'MODAL_WEBHOOK_URL',
  'TRANSCODE_INGEST_SECRET',
  'JWT_SECRET',
  'DELIVERY_URL',
  'INTERNAL_SWEEP_SECRET',
  'GROQ_API_KEY',
  'REDIS_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
] as const

/**
 * Canonical keys for the deployment `.env` (repo root) — what docker-compose.yml
 * interpolates and what the api/maintenance containers consume.
 *
 * Separate from server/.dev.vars on purpose: that file is *development* config,
 * and having the deployment stack read it made the two indistinguishable (the
 * deployment silently inherited a dev database URL and dev secrets).
 */
export const DEPLOY_KEY_ORDER = [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'DATABASE_URL',
  'DB_DRIVER',
  'REDIS_URL',
  'OPENVOD_API_PORT',
  'OPENVOD_WEB_PORT',
  'NEXT_PUBLIC_API_BASE_URL',
  'NEXT_PUBLIC_AUTH_BASE_URL',
  'NEXT_PUBLIC_FRONTEND_URL',
  'BETTER_AUTH_URL',
  'BACKEND_URL',
  'FRONTEND_URL',
  'CORS_ORIGINS',
  'BETTER_AUTH_SECRET',
  'JWT_SECRET',
  'TRANSCODE_INGEST_SECRET',
  'INTERNAL_SWEEP_SECRET',
  'SWEEP_ENABLED',
  'MAINTENANCE_INTERVAL_SECONDS',
  'ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'RAW_BUCKET_NAME',
  'TRANSCODED_BUCKET_NAME',
  'CLOUDFLARE_ANALYTICS_TOKEN',
  'DELIVERY_URL',
  'TRANSCODE_PROVIDER',
  'SELF_HOSTED_ENABLED',
  'UPLOADS_ENABLED',
  'MODAL_WEBHOOK_URL',
  'QSTASH_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'GROQ_API_KEY',
  'TRANSCODE_ORG_CONCURRENCY_CAP',
  'MAX_UPLOAD_SIZE_BYTES',
] as const

/** Canonical keys for delivery/.dev.vars. */
export const DELIVERY_KEY_ORDER = ['JWT_SECRET', 'DEFAULT_POLICY', 'DELIVERY_DEBUG'] as const

const SERVER_KEY_SET = new Set<string>(SERVER_KEY_ORDER)
const DELIVERY_KEY_SET = new Set<string>(DELIVERY_KEY_ORDER)
const DEPLOY_KEY_SET = new Set<string>(DEPLOY_KEY_ORDER)

export type EnvEntry = readonly [key: string, value: string]
export type EntryList = readonly EnvEntry[]

export function serverKeySet(): ReadonlySet<string> {
  return SERVER_KEY_SET
}

export function deliveryKeySet(): ReadonlySet<string> {
  return DELIVERY_KEY_SET
}

export function deployKeySet(): ReadonlySet<string> {
  return DEPLOY_KEY_SET
}

/**
 * DB driver derived from the runtime choice.
 *
 * Not a free choice: `pg` cannot work on Workers, which the server now refuses to
 * start with rather than failing on the second request.
 */
export function dbDriverFor(runtime: WizardAnswers['runtime']): 'neon-http' | 'pg' {
  return runtime === 'workers' ? 'neon-http' : 'pg'
}

/** The DATABASE_URL written for host-side tooling. */
export function databaseUrlFor(runtime: WizardAnswers['runtime'], db: DbAnswers): string {
  if (db.kind === 'local') return COMPOSE_LOCAL_DATABASE_URL
  if (db.url !== undefined && db.url.trim() !== '') return db.url.trim()
  // Unreachable after validateAnswers() passes; defensive fallback.
  return COMPOSE_LOCAL_DATABASE_URL
}

export function qstashToken(queue: QueueAnswers): string {
  return queue.kind === 'qstash' ? (queue.token ?? '').trim() : ''
}

export function upstashRedis(rateLimit: RateLimitAnswers): { url: string; token: string } {
  if (rateLimit.kind === 'upstash') {
    return { url: (rateLimit.restUrl ?? '').trim(), token: (rateLimit.token ?? '').trim() }
  }
  return { url: '', token: '' }
}

/**
 * The plain-Redis URL, or '' when another store was chosen.
 *
 * `REDIS_URL` takes precedence over Upstash in the API, so the two helpers are
 * mutually exclusive by construction: choosing one writes a blank for the other.
 */
export function plainRedisUrl(rateLimit: RateLimitAnswers): string {
  return rateLimit.kind === 'redis' ? (rateLimit.url ?? '').trim() : ''
}

/**
 * Hard validation problems that block env generation. Empty when the answers
 * are usable. (Pattern quirks — e.g. a non-32-hex account id — surface as
 * confirm-time warnings via warningsFor().)
 */
export function validateAnswers(answers: WizardAnswers): string[] {
  const problems: string[] = []

  if (answers.runtime !== 'workers' && answers.runtime !== 'node') {
    problems.push(`runtime must be "workers" or "node", got "${String(answers.runtime)}"`)
  }

  const db = answers.db
  if (!db || typeof db !== 'object') {
    problems.push('db must be an object: { kind, url? }')
  } else {
    if (answers.runtime === 'workers' && db.kind !== 'neon') {
      problems.push('runtime "workers" requires db.kind "neon" (the neon-http driver)')
    }
    if (answers.runtime === 'node' && db.kind !== 'local' && db.kind !== 'existing') {
      problems.push('runtime "node" requires db.kind "local" or "existing"')
    }
    if (db.kind !== 'local' && !db.url?.trim()) {
      problems.push(`db.kind "${String(db.kind)}" requires a db.url`)
    } else if (db.kind !== 'local' && !/^postgres(ql)?:\/\/\S+/.test(db.url ?? '')) {
      problems.push('db.url must be a postgres:// or postgresql:// URL')
    }
  }

  if (!answers.queue || (answers.queue.kind !== 'direct' && answers.queue.kind !== 'qstash')) {
    problems.push('queue.kind must be "direct" or "qstash"')
  } else if (answers.queue.kind === 'qstash' && !answers.queue.token?.trim()) {
    problems.push('queue.kind "qstash" requires a queue.token')
  }

  const rateLimitKinds: Array<RateLimitAnswers['kind']> = ['memory', 'redis', 'upstash']
  if (!answers.rateLimit || !rateLimitKinds.includes(answers.rateLimit.kind)) {
    problems.push('rateLimit.kind must be "memory", "redis" or "upstash"')
  } else if (answers.rateLimit.kind === 'redis') {
    if (!/^rediss?:\/\/\S+/.test(answers.rateLimit.url ?? '')) {
      problems.push('rateLimit "redis" requires a redis:// or rediss:// rateLimit.url')
    }
    if (answers.runtime === 'workers') {
      // A TCP socket is impossible on Workers. Refusing here is the point: the
      // alternative is a deployment whose limits are silently per-isolate.
      problems.push('rateLimit "redis" is not available on the Workers runtime — use "upstash"')
    }
  } else if (answers.rateLimit.kind === 'upstash') {
    if (!/^https?:\/\/\S+/.test(answers.rateLimit.restUrl ?? '')) {
      problems.push('rateLimit "upstash" requires an https rateLimit.restUrl')
    }
    if (!answers.rateLimit.token?.trim()) {
      problems.push('rateLimit "upstash" requires a rateLimit.token')
    }
  }

  for (const [key, label] of [
    ['accountId', 'accountId'],
    ['r2AccessKeyId', 'r2AccessKeyId'],
    ['r2SecretAccessKey', 'r2SecretAccessKey'],
    ['rawBucket', 'rawBucket'],
    ['transcodedBucket', 'transcodedBucket'],
  ] as const) {
    if (!answers[key]?.trim()) problems.push(`${label} is required`)
  }
  if (!/^https?:\/\/\S+/.test(answers.frontendUrl ?? '')) {
    problems.push('frontendUrl must be an absolute http(s) URL')
  }

  return problems
}

/** Non-blocking sanity warnings shown in the final summary. */
export function warningsFor(answers: WizardAnswers): string[] {
  const warnings: string[] = []
  if (answers.accountId && !/^[0-9a-f]{32}$/i.test(answers.accountId.trim())) {
    warnings.push('ACCOUNT_ID does not look like a 32-hex Cloudflare account id')
  }
  if (answers.rawBucket === answers.transcodedBucket) {
    warnings.push('raw and transcoded bucket names are identical — keep them distinct')
  }
  return warnings
}

/**
 * Build the full ordered env entries for server/.dev.vars. Optional values
 * are written as blank lines so users can fill them in later.
 */
export function buildServerEntries(
  answers: WizardAnswers,
  secrets: SecretSet,
): EntryList {
  const queueToken = qstashToken(answers.queue)
  const redis = upstashRedis(answers.rateLimit)
  const plainRedis = plainRedisUrl(answers.rateLimit)
  const dbUrl = databaseUrlFor(answers.runtime, answers.db)

  const entries: EnvEntry[] = [
    ['DATABASE_URL', dbUrl],
    ['DB_DRIVER', dbDriverFor(answers.runtime)],
    ['BETTER_AUTH_SECRET', secrets.betterAuthSecret],
    ['BETTER_AUTH_URL', 'http://localhost:8787'],
    ['FRONTEND_URL', answers.frontendUrl.trim()],
    ['CORS_ORIGINS', answers.frontendUrl.trim()],
    ['BACKEND_URL', 'http://localhost:8787'],
    ['ACCOUNT_ID', answers.accountId.trim()],
    ['R2_ACCESS_KEY_ID', answers.r2AccessKeyId.trim()],
    ['R2_SECRET_ACCESS_KEY', answers.r2SecretAccessKey.trim()],
    // Which engine new jobs use. Written explicitly so the choice is visible in
    // the file rather than implied by a default that may change later. `modal`
    // keeps an existing installation's behaviour identical.
    ['TRANSCODE_PROVIDER', answers.transcodeProvider ?? 'modal'],
    // Blank means "follow the provider". Set to `false` to roll back: it stops
    // accepting new self-hosted submissions and cancels nothing.
    ['SELF_HOSTED_ENABLED', answers.selfHostedEnabled ? 'true' : ''],
    // Whether browser/SDK uploads are accepted. The raw bucket is required by
    // *uploading*, not by transcoding, so turning this off is what makes a
    // local-only installation valid without one.
    ['UPLOADS_ENABLED', answers.uploadsEnabled === false ? 'false' : 'true'],
    ['RAW_BUCKET_NAME', answers.rawBucket.trim()],
    ['TRANSCODED_BUCKET_NAME', answers.transcodedBucket.trim()],
    ['CLOUDFLARE_ANALYTICS_TOKEN', ''],
    ['QSTASH_TOKEN', queueToken],
    ['MODAL_WEBHOOK_URL', ''],
    ['TRANSCODE_INGEST_SECRET', secrets.transcodeIngestSecret],
    ['JWT_SECRET', secrets.jwtSecret],
    ['DELIVERY_URL', ''],
    ['INTERNAL_SWEEP_SECRET', secrets.internalSweepSecret],
    ['GROQ_API_KEY', answers.groqApiKey?.trim() ?? ''],
    ['REDIS_URL', plainRedis],
    ['UPSTASH_REDIS_REST_URL', redis.url],
    ['UPSTASH_REDIS_REST_TOKEN', redis.token],
  ]
  return entries
}

/**
 * Build the deployment `.env` for docker-compose.yml.
 *
 * The bundled Postgres and Redis are used by default: `DATABASE_URL` and
 * `REDIS_URL` are left blank so the compose file composes them from the
 * POSTGRES_* values and the redis service. An operator pointing at their own
 * Postgres or Redis fills those two lines in.
 *
 * Public URLs default to localhost, which is what works until a reverse proxy is
 * in front. They are baked into the dashboard bundle at build time, so changing
 * them means rebuilding `web` — see .env.example.
 */
export function buildDeployEnvEntries(
  answers: WizardAnswers,
  secrets: SecretSet,
): EntryList {
  const redis = upstashRedis(answers.rateLimit)
  const externalDbUrl =
    answers.db.kind === 'existing' ? (answers.db.url ?? '').trim() : ''
  const frontend = answers.frontendUrl.trim()
  const apiBase = 'http://localhost:8787'

  return [
    ['POSTGRES_USER', 'postgres'],
    ['POSTGRES_PASSWORD', secrets.postgresPassword],
    ['POSTGRES_DB', 'openvod'],
    ['DATABASE_URL', externalDbUrl],
    ['DB_DRIVER', 'pg'],
    // Blank means the bundled Redis; set it to use your own.
    ['REDIS_URL', answers.rateLimit.kind === 'redis' ? (answers.rateLimit.url ?? '').trim() : ''],
    ['OPENVOD_API_PORT', '8787'],
    ['OPENVOD_WEB_PORT', '3000'],
    ['NEXT_PUBLIC_API_BASE_URL', `${apiBase}/api`],
    ['NEXT_PUBLIC_AUTH_BASE_URL', `${apiBase}/api/auth`],
    ['NEXT_PUBLIC_FRONTEND_URL', frontend],
    ['BETTER_AUTH_URL', apiBase],
    ['BACKEND_URL', apiBase],
    ['FRONTEND_URL', frontend],
    ['CORS_ORIGINS', frontend],
    ['BETTER_AUTH_SECRET', secrets.betterAuthSecret],
    ['JWT_SECRET', secrets.jwtSecret],
    ['TRANSCODE_INGEST_SECRET', secrets.transcodeIngestSecret],
    ['INTERNAL_SWEEP_SECRET', secrets.internalSweepSecret],
    ['SWEEP_ENABLED', 'true'],
    ['MAINTENANCE_INTERVAL_SECONDS', '900'],
    ['ACCOUNT_ID', answers.accountId.trim()],
    ['R2_ACCESS_KEY_ID', answers.r2AccessKeyId.trim()],
    ['R2_SECRET_ACCESS_KEY', answers.r2SecretAccessKey.trim()],
    ['RAW_BUCKET_NAME', answers.rawBucket.trim()],
    ['TRANSCODED_BUCKET_NAME', answers.transcodedBucket.trim()],
    ['CLOUDFLARE_ANALYTICS_TOKEN', ''],
    ['DELIVERY_URL', ''],
    ['TRANSCODE_PROVIDER', answers.transcodeProvider ?? 'modal'],
    ['SELF_HOSTED_ENABLED', answers.selfHostedEnabled ? 'true' : ''],
    ['UPLOADS_ENABLED', answers.uploadsEnabled === false ? 'false' : 'true'],
    ['MODAL_WEBHOOK_URL', ''],
    ['QSTASH_TOKEN', qstashToken(answers.queue)],
    ['UPSTASH_REDIS_REST_URL', redis.url],
    ['UPSTASH_REDIS_REST_TOKEN', redis.token],
    ['GROQ_API_KEY', answers.groqApiKey?.trim() ?? ''],
    ['TRANSCODE_ORG_CONCURRENCY_CAP', ''],
    ['MAX_UPLOAD_SIZE_BYTES', ''],
  ]
}

/** Build delivery/.dev.vars (JWT_SECRET mirrored from the API). */
export function buildDeliveryEntries(secrets: SecretSet): EntryList {
  return [
    ['JWT_SECRET', secrets.jwtSecret],
    ['DEFAULT_POLICY', 'public'],
    ['DELIVERY_DEBUG', 'false'],
  ]
}

/**
 * Reconstruct answers from an existing parsed server env — used for the
 * "--deploy with existing .dev.vars" flow, where we must not regenerate the
 * file (no --force) but still need bucket names/account/runtime to drive the
 * provision & deploy phase.
 */
export function deriveAnswersFromEnv(env: Record<string, string>): WizardAnswers {
  const driver = env['DB_DRIVER']
  const runtime: WizardAnswers['runtime'] = driver === 'pg' ? 'node' : 'workers'
  const dbUrl = (env['DATABASE_URL'] ?? '').trim()

  const db: DbAnswers =
    runtime === 'node'
      ? dbUrl === '' || dbUrl === DEV_LOCAL_DATABASE_URL
        ? { kind: 'local' }
        : { kind: 'existing', url: dbUrl }
      : { kind: 'neon', url: dbUrl }

  const queue: QueueAnswers = (env['QSTASH_TOKEN'] ?? '').trim()
    ? { kind: 'qstash', token: env['QSTASH_TOKEN'] }
    : { kind: 'direct' }

  // Same precedence the API uses, so re-reading a file reports what it will do.
  const rateLimit: RateLimitAnswers = (() => {
    const redisUrl = (env['REDIS_URL'] ?? '').trim()
    if (redisUrl) return { kind: 'redis', url: redisUrl }
    const restUrl = (env['UPSTASH_REDIS_REST_URL'] ?? '').trim()
    const token = (env['UPSTASH_REDIS_REST_TOKEN'] ?? '').trim()
    if (restUrl && token) return { kind: 'upstash', restUrl, token }
    return { kind: 'memory' }
  })()

  return {
    runtime,
    db,
    queue,
    rateLimit,
    accountId: (env['ACCOUNT_ID'] ?? '').trim(),
    r2AccessKeyId: (env['R2_ACCESS_KEY_ID'] ?? '').trim(),
    r2SecretAccessKey: (env['R2_SECRET_ACCESS_KEY'] ?? '').trim(),
    rawBucket: (env['RAW_BUCKET_NAME'] ?? '').trim(),
    transcodedBucket: (env['TRANSCODED_BUCKET_NAME'] ?? '').trim(),
    frontendUrl: (env['FRONTEND_URL'] ?? '').trim() || (env['CORS_ORIGINS'] ?? '').trim(),
    groqApiKey: (env['GROQ_API_KEY'] ?? '').trim() || undefined,
  }
}
