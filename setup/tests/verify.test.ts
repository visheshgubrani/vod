import { describe, expect, it } from 'vitest'
import { lintDeliveryMirror, lintEnvFiles, lintServerEnv, renderCheckRows } from '../src/verify'

function goodServerEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://user:pass@host/db',
    DB_DRIVER: 'neon-http',
    ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    R2_ACCESS_KEY_ID: 'r2-access-key-42',
    R2_SECRET_ACCESS_KEY: 'r2-secret-value-9f2c81',
    RAW_BUCKET_NAME: 'raw',
    TRANSCODED_BUCKET_NAME: 'transcoded',
    MODAL_WEBHOOK_URL: 'https://ws--x.modal.run',
    TRANSCODE_INGEST_SECRET: 'i'.repeat(40),
    JWT_SECRET: 'j'.repeat(40),
    BETTER_AUTH_SECRET: 'b'.repeat(40),
    DELIVERY_URL: 'https://media.example.com',
  }
}

describe('lintServerEnv', () => {
  it('passes a fully configured env', () => {
    const { rows, failed } = lintServerEnv(goodServerEnv())
    expect(failed).toBe(false)
    expect(rows.every((row) => row.ok || row.advisory)).toBe(true)
  })

  it('flags missing required keys but never their values', () => {
    const env = goodServerEnv()
    delete env['ACCOUNT_ID']
    delete env['MODAL_WEBHOOK_URL']
    const { rows, failed } = lintServerEnv(env)
    expect(failed).toBe(true)
    const texts = rows.map((row) => row.text)
    expect(texts.some((t) => t.includes('ACCOUNT_ID'))).toBe(true)
    expect(texts.some((t) => t.includes('Modal webhook URL'))).toBe(true)
    for (const row of rows) {
      expect(row.text).not.toContain('j'.repeat(40))
      expect(row.text).not.toContain(env['R2_SECRET_ACCESS_KEY'])
    }
  })

  it('flags secrets shorter than 32 chars', () => {
    const env = goodServerEnv()
    env['JWT_SECRET'] = 'short'
    const { failed } = lintServerEnv(env)
    expect(failed).toBe(true)
  })

  it('flags non-postgres DATABASE_URL values', () => {
    const env = goodServerEnv()
    env['DATABASE_URL'] = 'mysql://x/y'
    expect(lintServerEnv(env).failed).toBe(true)
  })

  it('treats placeholders as missing', () => {
    const env = goodServerEnv()
    env['ACCOUNT_ID'] = 'your-cloudflare-account-id'
    expect(lintServerEnv(env).failed).toBe(true)
  })
})

describe('lintDeliveryMirror', () => {
  it('accepts matching JWT secrets', () => {
    const jwt = 'j'.repeat(40)
    expect(lintDeliveryMirror(jwt, { JWT_SECRET: jwt })).toHaveLength(1)
  })

  it('rejects mismatched secrets', () => {
    const rows = lintDeliveryMirror('j'.repeat(40), { JWT_SECRET: 'k'.repeat(40) })
    expect(rows[0]?.ok).toBe(false)
  })

  it('rejects a missing delivery file', () => {
    expect(lintDeliveryMirror('j'.repeat(40), undefined)[0]?.ok).toBe(false)
  })
})

describe('lintEnvFiles + renderCheckRows', () => {
  it('short-circuits when server/.dev.vars is missing', () => {
    const { failed } = lintEnvFiles(undefined, undefined)
    expect(failed).toBe(true)
  })

  it('renders rows with ✓/✗/○ without leaking values', () => {
    const env = goodServerEnv()
    delete env['DELIVERY_URL']
    delete env['DB_DRIVER']
    const { rows } = lintServerEnv(env)
    const lines = renderCheckRows(rows)
    expect(lines[0]).toMatch(/^✓/)
    expect(lines.some((line) => line.includes('○'))).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// The raw bucket and Modal are conditional on the provider.
//
// Previously every row was required unconditionally, so a working local-only
// installation reported FAIL for a bucket it must not have and a Modal endpoint
// it will never call. A verification report that cries wolf is one people learn
// to ignore.
// ────────────────────────────────────────────────────────────────────────────

const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@host:5432/db',
  ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  TRANSCODED_BUCKET_NAME: 'clipmux-transcoded',
  JWT_SECRET: 'j'.repeat(40),
  BETTER_AUTH_SECRET: 'b'.repeat(40),
}

const rowFor = (env: Record<string, string>, fragment: string) =>
  lintServerEnv(env).rows.find((row) => row.text.includes(fragment))

describe('lintServerEnv with a self-hosted provider', () => {
  it('passes with no raw bucket and no Modal configuration', () => {
    const result = lintServerEnv({
      ...BASE,
      TRANSCODE_PROVIDER: 'self-hosted',
      UPLOADS_ENABLED: 'false',
    })
    expect(result.failed).toBe(false)
  })

  it('does not report the missing bucket as a failure', () => {
    const row = rowFor(
      { ...BASE, TRANSCODE_PROVIDER: 'self-hosted', UPLOADS_ENABLED: 'false' },
      'RAW_BUCKET_NAME',
    )
    expect(row?.ok).toBe(false)
    expect(row?.advisory).toBe(true)
    expect(row?.text).toContain('not needed')
  })

  it('requires the bucket again when uploads are enabled', () => {
    // Hybrid install: local imports work, but browser uploads need somewhere to
    // land, and silently accepting them would fail at the first upload.
    const result = lintServerEnv({
      ...BASE,
      TRANSCODE_PROVIDER: 'self-hosted',
      UPLOADS_ENABLED: 'true',
    })
    expect(result.failed).toBe(true)
    expect(rowFor({ ...BASE, TRANSCODE_PROVIDER: 'self-hosted' }, 'RAW_BUCKET_NAME')?.advisory)
      .toBeUndefined()
  })

  it('treats a missing Modal endpoint as advisory, not a failure', () => {
    const row = rowFor({ ...BASE, TRANSCODE_PROVIDER: 'self-hosted' }, 'MODAL_WEBHOOK_URL')
    expect(row?.advisory).toBe(true)
  })

  it('keeps the Modal requirements when the provider is Modal', () => {
    const result = lintServerEnv({ ...BASE, TRANSCODE_PROVIDER: 'modal' })
    expect(result.failed).toBe(true)
    expect(rowFor({ ...BASE, TRANSCODE_PROVIDER: 'modal' }, 'MODAL_WEBHOOK_URL')?.advisory)
      .toBeUndefined()
  })

  it('defaults to the Modal requirements when the provider is unset', () => {
    // An existing installation that has never heard of TRANSCODE_PROVIDER must
    // see exactly the report it saw before.
    const result = lintServerEnv(BASE)
    expect(result.failed).toBe(true)
    expect(rowFor(BASE, 'RAW_BUCKET_NAME')?.advisory).toBeUndefined()
  })
})
