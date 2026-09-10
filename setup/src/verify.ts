/**
 * Local env verification — mirrors scripts/verify-env.sh logic (no secrets
 * printed, only presence/length checks) so the wizard's final report and
 * `--check` mode use the same rules as the standalone shell verifier.
 */

export interface CheckRow {
  ok: boolean
  /** Advisory rows (○) never fail the run. */
  advisory?: boolean
  text: string
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
    rows.push({ ok, text: `${label} (${key})` })
  }
  const advisory = (key: string, label: string) => {
    const ok = isSet(env[key])
    rows.push({ ok, advisory: true, text: `${label} (${key})` })
  }

  const db = env['DATABASE_URL']
  const dbOk = isSet(db) && /^postgres(ql)?:\/\/\S+/.test(db ?? '')
  if (!dbOk) failed = true
  rows.push({ ok: dbOk, text: 'Postgres connection URL (DATABASE_URL)' })

  advisory('DB_DRIVER', 'DB driver (neon-http | pg)')
  check('ACCOUNT_ID', 'Cloudflare account id')
  check('R2_ACCESS_KEY_ID', 'R2 access key id')
  check('R2_SECRET_ACCESS_KEY', 'R2 secret access key')
  check('RAW_BUCKET_NAME', 'Raw bucket')
  check('TRANSCODED_BUCKET_NAME', 'Transcoded bucket')
  check('MODAL_WEBHOOK_URL', 'Modal webhook URL')
  check('TRANSCODE_INGEST_SECRET', 'Transcode ingest secret')
  check('JWT_SECRET', 'Playback JWT secret (>=32 chars)')
  check('BETTER_AUTH_SECRET', 'Auth secret (>=32 chars)')
  advisory('DELIVERY_URL', 'Delivery worker base URL')

  for (const key of ['JWT_SECRET', 'BETTER_AUTH_SECRET'] as const) {
    const value = env[key]
    if (isSet(value) && value.trim().length < MIN_SECRET_LENGTH) {
      failed = true
      rows.push({ ok: false, text: `${key} shorter than 32 chars` })
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
    return [{ ok: false, text: 'delivery/.dev.vars missing (JWT_SECRET must match the API)' }]
  }
  const dJwt = deliveryEnv['JWT_SECRET']
  if (!isSet(serverJwt) || !isSet(dJwt)) {
    return [{ ok: false, text: 'delivery/.dev.vars JWT_SECRET does not match the API' }]
  }
  if (serverJwt !== dJwt) {
    return [{ ok: false, text: 'delivery/.dev.vars JWT_SECRET does not match the API' }]
  }
  return [{ ok: true, text: 'delivery/.dev.vars JWT_SECRET matches the API' }]
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
