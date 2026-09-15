/**
 * Pure mapping from wizard decisions to the env contract consumed by
 * server/.dev.vars and delivery/.dev.vars (see server/.dev.vars.example and
 * server/src/lib/config.ts). This module is the TDD seam: every decision a
 * user makes ends up here, so the mapping is exhaustively unit-tested.
 */

import type {
  ConfigTarget,
  DbAnswers,
  DbKind,
  QueueAnswers,
  QueueKind,
  RateLimitAnswers,
  RateLimitKind,
  RuntimeKind,
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

/**
 * Canonical key order for server/.dev.vars (mirrors .dev.vars.example).
 *
 * The three provider keys belong here even though they are not in the
 * `.example` file: this set decides which pre-existing keys a regeneration may
 * rewrite. Leaving them out meant a `--force` run wrote the new
 * `TRANSCODE_PROVIDER` as a canonical line *and* preserved the old one as an
 * unknown key — and since the parser takes the last occurrence, the stale value
 * silently won. `wrangler secret bulk` reads this list too, so an omission also
 * kept the provider flag out of a deployed Worker.
 */
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
  'TRANSCODE_PROVIDER',
  'SELF_HOSTED_ENABLED',
  'UPLOADS_ENABLED',
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
  'CLIPMUX_API_PORT',
  'CLIPMUX_WEB_PORT',
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

/** Whether browser/SDK uploads are accepted. Omitted means true. */
export function uploadsEnabled(answers: WizardAnswers): boolean {
  return answers.uploadsEnabled !== false
}

/** The transcoder that new jobs use. Omitted means Modal. */
export function transcodeProvider(answers: WizardAnswers): 'modal' | 'self-hosted' {
  return answers.transcodeProvider === 'self-hosted' ? 'self-hosted' : 'modal'
}

/**
 * Whether a raw upload bucket is part of this installation.
 *
 * A raw bucket exists to serve *uploads*. A local-only installation — the
 * self-hosted provider with uploads switched off — needs none, and writing the
 * default bucket name anyway would make the wizard provision a bucket nobody
 * writes to (and tell the operator to create it).
 */
export function needsRawBucket(answers: WizardAnswers): boolean {
  return uploadsEnabled(answers) || transcodeProvider(answers) === 'modal'
}

/** The RAW_BUCKET_NAME value to write, or '' when the bucket is not used. */
export function rawBucketValue(answers: WizardAnswers): string {
  return needsRawBucket(answers) ? answers.rawBucket.trim() : ''
}

/**
 * `SELF_HOSTED_ENABLED` as written to the environment.
 *
 * Three states, and the difference matters: `true`, an explicit `false` (the
 * documented rollback, which must survive a regeneration), and unset (`''`,
 * meaning "follow the provider"). Serialising an explicit false as blank turned
 * it back into "follow the provider", which re-enabled local submission on the
 * very installation that had switched it off.
 */
export function selfHostedEnabledValue(answers: WizardAnswers): string {
  if (answers.selfHostedEnabled === true) return 'true'
  if (answers.selfHostedEnabled === false) return 'false'
  return ''
}

/**
 * The decisions a run makes, as the choice stage knows them.
 *
 * Deliberately not `WizardAnswers`: compatibilities must be checkable *before*
 * any credential exists — that is what keeps a combination that cannot work
 * from starting an installation.
 */
export interface ChoiceShape {
  target?: ConfigTarget
  runtime: RuntimeKind
  dbKind?: DbKind
  transcodeProvider?: 'modal' | 'self-hosted'
  uploadsEnabled?: boolean
  queueKind?: QueueKind
  rateLimitKind?: RateLimitKind
}

/**
 * Hard validation problems that block env generation, split by when they can be
 * checked.
 *
 * `validateChoices` runs before anything is installed (a combination that
 * cannot work must not start installing packages), `validateCredentials` after
 * the values have been collected. `validateAnswers` is both, for one-shot
 * callers such as the headless answers path.
 */
export function validateChoices(shape: ChoiceShape): string[] {
  const problems: string[] = []

  if (shape.target !== undefined && shape.target !== 'dev' && shape.target !== 'deploy') {
    problems.push(`target must be "dev" or "deploy", got "${String(shape.target)}"`)
  }
  if (shape.runtime !== 'workers' && shape.runtime !== 'node') {
    problems.push(`runtime must be "workers" or "node", got "${String(shape.runtime)}"`)
  }

  const dbKind = shape.dbKind
  if (dbKind !== 'neon' && dbKind !== 'local' && dbKind !== 'existing') {
    problems.push(`db.kind must be "neon", "local" or "existing", got "${String(dbKind)}"`)
  } else {
    if (shape.runtime === 'workers' && dbKind !== 'neon') {
      problems.push('runtime "workers" requires db.kind "neon" (the neon-http driver)')
    }
    if (shape.runtime === 'node' && dbKind !== 'local' && dbKind !== 'existing') {
      problems.push('runtime "node" requires db.kind "local" or "existing"')
    }
  }

  if (shape.queueKind !== 'direct' && shape.queueKind !== 'qstash') {
    problems.push('queue.kind must be "direct" or "qstash"')
  }

  const rateLimitKind = shape.rateLimitKind
  if (rateLimitKind !== 'memory' && rateLimitKind !== 'redis' && rateLimitKind !== 'upstash') {
    problems.push('rateLimit.kind must be "memory", "redis" or "upstash"')
  } else if (rateLimitKind === 'redis' && shape.runtime === 'workers') {
    // A TCP socket is impossible on Workers. Refusing here is the point: the
    // alternative is a deployment whose limits are silently per-isolate.
    problems.push('rateLimit "redis" is not available on the Workers runtime — use "upstash"')
  }

  if (
    shape.transcodeProvider !== undefined &&
    shape.transcodeProvider !== 'modal' &&
    shape.transcodeProvider !== 'self-hosted'
  ) {
    problems.push(
      `transcodeProvider must be "modal" or "self-hosted", got "${String(shape.transcodeProvider)}"`,
    )
  }
  if (shape.transcodeProvider !== 'self-hosted' && shape.uploadsEnabled === false) {
    // Modal reads its input from the raw bucket, so there is nothing for it to
    // transcode: uploads off is only meaningful for the self-hosted provider.
    problems.push(
      'transcodeProvider "modal" requires uploads (Modal ingests from the raw bucket) — ' +
        'use "self-hosted" for a local-only installation',
    )
  }

  return problems
}

/** `validateChoices` for a complete answers object. */
export function validateChoicesOf(answers: WizardAnswers): string[] {
  return validateChoices({
    ...(answers.target !== undefined ? { target: answers.target } : {}),
    runtime: answers.runtime,
    ...(answers.db?.kind !== undefined ? { dbKind: answers.db.kind } : {}),
    ...(answers.transcodeProvider !== undefined
      ? { transcodeProvider: answers.transcodeProvider }
      : {}),
    ...(answers.uploadsEnabled !== undefined ? { uploadsEnabled: answers.uploadsEnabled } : {}),
    ...(answers.queue?.kind !== undefined ? { queueKind: answers.queue.kind } : {}),
    ...(answers.rateLimit?.kind !== undefined ? { rateLimitKind: answers.rateLimit.kind } : {}),
  })
}

export function validateCredentials(answers: WizardAnswers): string[] {
  const problems: string[] = []

  const db = answers.db
  if (db && typeof db === 'object' && db.kind !== 'local') {
    if (!db.url?.trim()) {
      problems.push(`db.kind "${String(db.kind)}" requires a db.url`)
    } else if (!/^postgres(ql)?:\/\/\S+/.test(db.url)) {
      problems.push('db.url must be a postgres:// or postgresql:// URL')
    }
  }

  if (answers.queue?.kind === 'qstash' && !answers.queue.token?.trim()) {
    problems.push('queue.kind "qstash" requires a queue.token')
  }

  if (answers.rateLimit?.kind === 'redis') {
    if (!/^rediss?:\/\/\S+/.test(answers.rateLimit.url ?? '')) {
      problems.push('rateLimit "redis" requires a redis:// or rediss:// rateLimit.url')
    }
  } else if (answers.rateLimit?.kind === 'upstash') {
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
    ['transcodedBucket', 'transcodedBucket'],
  ] as const) {
    if (!answers[key]?.trim()) problems.push(`${label} is required`)
  }
  if (needsRawBucket(answers) && !answers.rawBucket?.trim()) {
    problems.push('rawBucket is required (uploads are enabled, or the provider is Modal)')
  }
  if (!/^https?:\/\/\S+/.test(answers.frontendUrl ?? '')) {
    problems.push('frontendUrl must be an absolute http(s) URL')
  }

  return problems
}

/** Both stages, for callers that validate a complete answers object at once. */
export function validateAnswers(answers: WizardAnswers): string[] {
  return [...validateChoicesOf(answers), ...validateCredentials(answers)]
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
  // The agent image ships neither faster-whisper nor the Groq client, so a Groq
  // key on a self-hosted install buys nothing today. Saying so here is the
  // difference between an operator waiting for subtitles that never appear and
  // an operator choosing Modal.
  if (transcodeProvider(answers) === 'self-hosted' && (answers.groqApiKey ?? '').trim() !== '') {
    warnings.push(
      'GROQ_API_KEY is set, but AI subtitles/chapters are not available for the ' +
        'self-hosted provider yet (the agent image ships neither Whisper nor the Groq ' +
        'client — see docs/known-gaps.md). Use the Modal provider for AI enrichment.',
    )
  }
  return warnings
}

/**
 * Build the full ordered env entries for the `dev` target (server/.dev.vars).
 * Optional values are written as blank lines so users can fill them in later.
 */
export function buildDevConfig(
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
    ['TRANSCODE_PROVIDER', transcodeProvider(answers)],
    // Blank means "follow the provider"; `false` is the documented rollback and
    // survives a regeneration.
    ['SELF_HOSTED_ENABLED', selfHostedEnabledValue(answers)],
    // Whether browser/SDK uploads are accepted. The raw bucket is required by
    // *uploading*, not by transcoding, so turning this off is what makes a
    // local-only installation valid without one.
    ['UPLOADS_ENABLED', uploadsEnabled(answers) ? 'true' : 'false'],
    ['RAW_BUCKET_NAME', rawBucketValue(answers)],
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
 * Build the deployment `.env` for docker-compose.yml (the `deploy` target).
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
export function buildDeployConfig(
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
    ['POSTGRES_DB', 'clipmux'],
    ['DATABASE_URL', externalDbUrl],
    ['DB_DRIVER', 'pg'],
    // Blank means the bundled Redis; set it to use your own.
    ['REDIS_URL', answers.rateLimit.kind === 'redis' ? (answers.rateLimit.url ?? '').trim() : ''],
    ['CLIPMUX_API_PORT', '8787'],
    ['CLIPMUX_WEB_PORT', '3000'],
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
    ['RAW_BUCKET_NAME', rawBucketValue(answers)],
    ['TRANSCODED_BUCKET_NAME', answers.transcodedBucket.trim()],
    ['CLOUDFLARE_ANALYTICS_TOKEN', ''],
    ['DELIVERY_URL', ''],
    ['TRANSCODE_PROVIDER', transcodeProvider(answers)],
    ['SELF_HOSTED_ENABLED', selfHostedEnabledValue(answers)],
    ['UPLOADS_ENABLED', uploadsEnabled(answers) ? 'true' : 'false'],
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
 * Reconstruct answers from an existing parsed config — used for the
 * "--deploy with an existing file" flow, where we must not regenerate the file
 * (no --force) but still need bucket names/account/provider to drive the
 * provision & deploy phase.
 *
 * The provider flags are read, not assumed: a `self-hosted` installation that
 * was reconfigured through `--deploy` used to be read back as `modal`, and the
 * deploy phase then tried to provision a Modal pipeline for a machine that
 * never uses one. A file written before the flags existed reads as modal with
 * uploads on, which is what those installations do.
 */
export function deriveAnswersFromConfig(
  target: ConfigTarget,
  env: Record<string, string>,
): WizardAnswers {
  const driver = env['DB_DRIVER']
  const runtime: WizardAnswers['runtime'] =
    target === 'deploy' ? 'node' : driver === 'pg' ? 'node' : 'workers'
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

  const providerRaw = (env['TRANSCODE_PROVIDER'] ?? '').trim().toLowerCase()
  const transcodeProvider: 'modal' | 'self-hosted' =
    providerRaw === 'self-hosted' || providerRaw === 'selfhosted' || providerRaw === 'local'
      ? 'self-hosted'
      : 'modal'
  const selfHostedRaw = (env['SELF_HOSTED_ENABLED'] ?? '').trim().toLowerCase()
  const uploadsRaw = (env['UPLOADS_ENABLED'] ?? '').trim().toLowerCase()

  return {
    target,
    runtime,
    db,
    queue,
    rateLimit,
    accountId: (env['ACCOUNT_ID'] ?? '').trim(),
    r2AccessKeyId: (env['R2_ACCESS_KEY_ID'] ?? '').trim(),
    r2SecretAccessKey: (env['R2_SECRET_ACCESS_KEY'] ?? '').trim(),
    rawBucket: (env['RAW_BUCKET_NAME'] ?? '').trim(),
    transcodedBucket: (env['TRANSCODED_BUCKET_NAME'] ?? '').trim(),
    transcodeProvider,
    ...(selfHostedRaw === '' ? {} : { selfHostedEnabled: selfHostedRaw === 'true' || selfHostedRaw === '1' }),
    uploadsEnabled: uploadsRaw === '' ? true : uploadsRaw !== 'false',
    frontendUrl: (env['FRONTEND_URL'] ?? '').trim() || (env['CORS_ORIGINS'] ?? '').trim(),
    groqApiKey: (env['GROQ_API_KEY'] ?? '').trim() || undefined,
  }
}

/** @deprecated Kept for callers that predate the dev/deploy split; use deriveAnswersFromConfig. */
export function deriveAnswersFromEnv(env: Record<string, string>): WizardAnswers {
  return deriveAnswersFromConfig('dev', env)
}
