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
 * Compose-mode Postgres URL for HOST-side tooling (wrangler dev, node). The
 * api container ignores this value — docker-compose.yml `environment` forces
 * the container-internal `postgres:5432` URL and overrides env_file.
 */
export const COMPOSE_LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/vod_dev'

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
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
] as const

/** Canonical keys for delivery/.dev.vars. */
export const DELIVERY_KEY_ORDER = ['JWT_SECRET', 'DEFAULT_POLICY', 'DELIVERY_DEBUG'] as const

const SERVER_KEY_SET = new Set<string>(SERVER_KEY_ORDER)
const DELIVERY_KEY_SET = new Set<string>(DELIVERY_KEY_ORDER)

export type EnvEntry = readonly [key: string, value: string]
export type EntryList = readonly EnvEntry[]

export function serverKeySet(): ReadonlySet<string> {
  return SERVER_KEY_SET
}

export function deliveryKeySet(): ReadonlySet<string> {
  return DELIVERY_KEY_SET
}

/** DB driver derived from the runtime choice. */
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
 * Hard validation problems that block env generation. Empty when the answers
 * are usable. (Pattern quirks — e.g. a non-32-hex account id — surface as
 * confirm-time warnings via warningsFor().)
 */
export function validateAnswers(answers: WizardAnswers): string[] {
  const problems: string[] = []

  if (answers.runtime !== 'workers' && answers.runtime !== 'compose') {
    problems.push(`runtime must be "workers" or "compose", got "${String(answers.runtime)}"`)
  }

  const db = answers.db
  if (!db || typeof db !== 'object') {
    problems.push('db must be an object: { kind, url? }')
  } else {
    if (answers.runtime === 'workers' && db.kind !== 'neon') {
      problems.push('runtime "workers" requires db.kind "neon" (the neon-http driver)')
    }
    if (answers.runtime === 'compose' && db.kind !== 'local' && db.kind !== 'existing') {
      problems.push('runtime "compose" requires db.kind "local" or "existing"')
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

  if (
    !answers.rateLimit ||
    (answers.rateLimit.kind !== 'memory' && answers.rateLimit.kind !== 'upstash')
  ) {
    problems.push('rateLimit.kind must be "memory" or "upstash"')
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
    ['UPSTASH_REDIS_REST_URL', redis.url],
    ['UPSTASH_REDIS_REST_TOKEN', redis.token],
  ]
  return entries
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
  const runtime: WizardAnswers['runtime'] = driver === 'pg' ? 'compose' : 'workers'
  const dbUrl = (env['DATABASE_URL'] ?? '').trim()

  const db: DbAnswers =
    runtime === 'compose'
      ? dbUrl === '' || dbUrl === COMPOSE_LOCAL_DATABASE_URL
        ? { kind: 'local' }
        : { kind: 'existing', url: dbUrl }
      : { kind: 'neon', url: dbUrl }

  const queue: QueueAnswers = (env['QSTASH_TOKEN'] ?? '').trim()
    ? { kind: 'qstash', token: env['QSTASH_TOKEN'] }
    : { kind: 'direct' }

  const rateLimit: RateLimitAnswers =
    (env['UPSTASH_REDIS_REST_URL'] ?? '').trim() && (env['UPSTASH_REDIS_REST_TOKEN'] ?? '').trim()
      ? {
          kind: 'upstash',
          restUrl: env['UPSTASH_REDIS_REST_URL'],
          token: env['UPSTASH_REDIS_REST_TOKEN'],
        }
      : { kind: 'memory' }

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
