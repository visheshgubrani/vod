/**
 * Local env verification. No secrets printed — only presence/length checks
 * so the wizard's final report and `--check` mode share one set of rules.
 */

export interface CheckRow {
  ok: boolean
  /** Advisory rows (○) never fail the run. */
  advisory?: boolean
  text: string
  /** The env key behind the row, so callers can point at where to get it. */
  key?: string
}

const MIN_SECRET_LENGTH = 32

function isSet(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false
  const v = value.trim()
  if (v === 'your-*' || v === 'change-me' || v.startsWith('your-')) return false
  if (v.includes('change-me')) return false
  return true
}

/** Lint a parsed server env (Record). Returns rows; failed = any non-advisory !ok. */
export function lintServerEnv(env: Record<string, string>): { rows: CheckRow[]; failed: boolean } {
  const rows: CheckRow[] = []
  let failed = false

  const check = (key: string, label: string) => {
    const ok = isSet(env[key])
    if (!ok) failed = true
    rows.push({ ok, text: `${label} (${key})`, key })
  }
  const advisory = (key: string, label: string) => {
    const ok = isSet(env[key])
    rows.push({ ok, advisory: true, text: `${label} (${key})`, key })
  }

  const db = env['DATABASE_URL']
  const dbOk = isSet(db) && /^postgres(ql)?:\/\/\S+/.test(db ?? '')
  if (!dbOk) failed = true
  rows.push({ ok: dbOk, text: 'Postgres connection URL (DATABASE_URL)', key: 'DATABASE_URL' })

  advisory('DB_DRIVER', 'DB driver (neon-http | pg)')
  check('ACCOUNT_ID', 'Cloudflare account id')
  check('R2_ACCESS_KEY_ID', 'R2 access key id')
  check('R2_SECRET_ACCESS_KEY', 'R2 secret access key')
  check('TRANSCODED_BUCKET_NAME', 'Transcoded bucket')

  // The provider decides what else is required. Telling a local-only
  // installation that it is broken for lacking a raw bucket and a Modal
  // endpoint is the fastest way to make a working install look unfinished.
  const provider = (env['TRANSCODE_PROVIDER'] ?? 'modal').trim().toLowerCase()
  const selfHosted = provider === 'self-hosted' || provider === 'selfhosted' || provider === 'local'
  const uploadsEnabled = (env['UPLOADS_ENABLED'] ?? 'true').trim().toLowerCase() !== 'false'

  if (selfHosted && !uploadsEnabled) {
    advisory('RAW_BUCKET_NAME', 'Raw bucket (not needed: uploads are off)')
  } else {
    check('RAW_BUCKET_NAME', 'Raw bucket')
  }

  if (selfHosted) {
    advisory('MODAL_WEBHOOK_URL', 'Modal webhook URL (optional: self-hosted provider)')
    advisory('TRANSCODE_INGEST_SECRET', 'Transcode ingest secret (only used by Modal callbacks)')
  } else {
    check('MODAL_WEBHOOK_URL', 'Modal webhook URL')
    check('TRANSCODE_INGEST_SECRET', 'Transcode ingest secret')
  }
  check('JWT_SECRET', 'Playback JWT secret (>=32 chars)')
  check('BETTER_AUTH_SECRET', 'Auth secret (>=32 chars)')
  advisory('DELIVERY_URL', 'Delivery worker base URL')

  for (const key of ['JWT_SECRET', 'BETTER_AUTH_SECRET'] as const) {
    const value = env[key]
    if (isSet(value) && value.trim().length < MIN_SECRET_LENGTH) {
      failed = true
      rows.push({ ok: false, text: `${key} shorter than 32 chars`, key })
    }
  }

  return { rows, failed }
}

/**
 * Compare delivery JWT against the server JWT. serverJwt may be undefined
 * when the server file itself is missing.
 */
export function lintDeliveryMirror(
  serverJwt: string | undefined,
  deliveryEnv: Record<string, string> | undefined,
): CheckRow[] {
  if (!deliveryEnv) {
    return [
      { ok: false, text: 'delivery/.dev.vars missing (JWT_SECRET must match the API)', key: 'JWT_SECRET' },
    ]
  }
  const dJwt = deliveryEnv['JWT_SECRET']
  if (!isSet(serverJwt) || !isSet(dJwt)) {
    return [
      { ok: false, text: 'delivery/.dev.vars JWT_SECRET does not match the API', key: 'JWT_SECRET' },
    ]
  }
  if (serverJwt !== dJwt) {
    return [
      { ok: false, text: 'delivery/.dev.vars JWT_SECRET does not match the API', key: 'JWT_SECRET' },
    ]
  }
  return [{ ok: true, text: 'delivery/.dev.vars JWT_SECRET matches the API', key: 'JWT_SECRET' }]
}

/** Full report for both files given as parsed maps. */
export function lintEnvFiles(
  serverEnv: Record<string, string> | undefined,
  deliveryEnv: Record<string, string> | undefined,
): { rows: CheckRow[]; failed: boolean } {
  const rows: CheckRow[] = []
  let failed = false
  if (!serverEnv) {
    rows.push({ ok: false, text: 'server/.dev.vars missing — run ./scripts/bootstrap.sh first' })
    return { rows, failed: true }
  }
  const server = lintServerEnv(serverEnv)
  rows.push(...server.rows)
  failed = server.failed
  rows.push(...lintDeliveryMirror(serverEnv['JWT_SECRET'], deliveryEnv))
  for (const row of rows.slice(-1)) if (!row.ok && !row.advisory) failed = true
  return { rows, failed }
}

/**
 * Lint the root `.env` — the Docker Compose deployment config.
 *
 * A different file answers different questions than `.dev.vars`, so it gets its
 * own rules: the bundled Postgres/Redis are configured through `POSTGRES_*`,
 * `DATABASE_URL` and `REDIS_URL` may both be blank, and the delivery worker's
 * secret lives here rather than in a mirror file.
 */
export function lintDeployEnv(env: Record<string, string>): { rows: CheckRow[]; failed: boolean } {
  const rows: CheckRow[] = []
  let failed = false

  const check = (key: string, label: string) => {
    const ok = isSet(env[key])
    if (!ok) failed = true
    rows.push({ ok, text: `${label} (${key})`, key })
  }
  const advisory = (key: string, label: string) => {
    rows.push({ ok: isSet(env[key]), advisory: true, text: `${label} (${key})`, key })
  }

  const externalDb = (env['DATABASE_URL'] ?? '').trim()
  if (externalDb === '') {
    const bundledOk = isSet(env['POSTGRES_USER']) && isSet(env['POSTGRES_PASSWORD']) && isSet(env['POSTGRES_DB'])
    if (!bundledOk) failed = true
    rows.push({
      ok: bundledOk,
      text: 'Bundled Postgres (POSTGRES_USER/PASSWORD/DB) — or an external DATABASE_URL',
      key: 'DATABASE_URL',
    })
    advisory('POSTGRES_PASSWORD', 'Bundled Postgres password')
  } else {
    const ok = /^postgres(ql)?:\/\//.test(externalDb)
    if (!ok) failed = true
    rows.push({ ok, text: 'External Postgres URL (DATABASE_URL)', key: 'DATABASE_URL' })
  }
  advisory('REDIS_URL', 'Rate-limit Redis (blank = bundled redis service)')

  check('BETTER_AUTH_SECRET', 'Auth secret (>=32 chars)')
  check('JWT_SECRET', 'Playback JWT secret (>=32 chars)')
  check('INTERNAL_SWEEP_SECRET', 'Sweeper secret (generated)')
  check('TRANSCODE_INGEST_SECRET', 'Transcode ingest secret (generated)')
  check('FRONTEND_URL', 'Dashboard origin')
  check('NEXT_PUBLIC_API_BASE_URL', 'Dashboard → API base URL (baked at build time)')
  check('ACCOUNT_ID', 'Cloudflare account id')
  check('R2_ACCESS_KEY_ID', 'R2 access key id')
  check('R2_SECRET_ACCESS_KEY', 'R2 secret access key')
  check('TRANSCODED_BUCKET_NAME', 'Transcoded bucket')

  const provider = (env['TRANSCODE_PROVIDER'] ?? 'modal').trim().toLowerCase()
  const selfHosted = provider === 'self-hosted' || provider === 'selfhosted' || provider === 'local'
  const uploadsOn = (env['UPLOADS_ENABLED'] ?? 'true').trim().toLowerCase() !== 'false'

  if (selfHosted && !uploadsOn) {
    advisory('RAW_BUCKET_NAME', 'Raw bucket (not needed: uploads are off)')
  } else {
    check('RAW_BUCKET_NAME', 'Raw bucket')
  }
  if (selfHosted) {
    advisory('MODAL_WEBHOOK_URL', 'Modal webhook URL (optional: self-hosted provider)')
  } else {
    check('MODAL_WEBHOOK_URL', 'Modal webhook URL')
  }
  advisory('DELIVERY_URL', 'Delivery worker base URL')

  for (const key of ['JWT_SECRET', 'BETTER_AUTH_SECRET'] as const) {
    const value = env[key]
    if (isSet(value) && value.trim().length < MIN_SECRET_LENGTH) {
      failed = true
      rows.push({ ok: false, text: `${key} shorter than 32 chars`, key })
    }
  }

  return { rows, failed }
}

export function renderCheckRows(rows: CheckRow[]): string[] {
  return rows.map((row) => {
    const icon = row.ok ? '✓' : row.advisory ? '○' : '✗'
    const suffix = row.advisory ? ' — optional / advisory' : row.ok ? '' : ' — missing or placeholder'
    return `${icon} ${row.text}${suffix}`
  })
}

/** Mask a secret for display: show length only. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '(empty)'
  if (value.length <= 8) return '••••'
  return `••••${value.length - 4} chars`
}
