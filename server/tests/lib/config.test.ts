import { afterEach, describe, expect, it } from 'vitest'
import {
  loadConfig,
  requirePlaybackJwtSecret,
  readDeliveryBaseUrl,
  maxUploadBytes,
  DEFAULT_MAX_UPLOAD_BYTES,
} from '../../src/lib/config'

const FULL_ENV = {
  DATABASE_URL: 'postgresql://user:pass@db.example.com/neondb?sslmode=require',
  BETTER_AUTH_SECRET: 'a-32-character-secret-string-1234567890',
  JWT_SECRET: 'another-32-character-secret-string-9876543',
  ACCOUNT_ID: 'cf-account-123',
  R2_ACCESS_KEY_ID: 'r2-access-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret-key',
  RAW_BUCKET_NAME: 'raw-uploads',
  TRANSCODED_BUCKET_NAME: 'transcoded-media',
  MODAL_WEBHOOK_URL: 'https://user--app.modal.run/transcode',
  MODAL_WEBHOOK_SECRET: 'modal-secret',
  TRANSCODE_INGEST_SECRET: 'ingest-secret',
  DELIVERY_URL: 'https://media.example.com',
  CLOUDFLARE_ANALYTICS_TOKEN: 'analytics-token',
  GROQ_API_KEY: 'groq-key',
}

describe('loadConfig', () => {
  it('reports every missing capability as not ready with problems', () => {
    const cfg = loadConfig({})

    expect(cfg.ready).toBe(false)
    expect(cfg.checks.database).toBe(false)
    expect(cfg.checks.storage).toBe(false)
    expect(cfg.checks.transcoder).toBe(false)
    expect(cfg.checks.auth).toBe(false)
    expect(cfg.checks.analytics).toBe(false)
    expect(cfg.checks.ai).toBe(false)
    expect(cfg.checks.delivery).toBe(false)
    expect(cfg.problems.length).toBeGreaterThanOrEqual(6)
    expect(cfg.problems.some((p) => p.includes('DATABASE_URL'))).toBe(true)
    expect(cfg.problems.some((p) => p.includes('JWT_SECRET'))).toBe(true)
  })

  it('is ready when all capabilities are configured', () => {
    const cfg = loadConfig(FULL_ENV)

    expect(cfg.ready).toBe(true)
    expect(cfg.problems).toEqual([])
    expect(cfg.checks).toEqual({
      database: true,
      storage: true,
      transcoder: true,
      auth: true,
      analytics: true,
      ai: true,
      delivery: true,
    })
    expect(cfg.jwtSecret).toBe(FULL_ENV.JWT_SECRET)
    expect(cfg.deliveryUrl).toBe('https://media.example.com')
  })

  it('flags a too-short JWT secret instead of accepting it', () => {
    const cfg = loadConfig({ ...FULL_ENV, JWT_SECRET: 'short' })

    expect(cfg.checks.auth).toBe(false)
    expect(cfg.problems.some((p) => p.includes('JWT_SECRET'))).toBe(true)
    expect(cfg.jwtSecret).toBeNull()
  })

  it('flags delivery URL without a scheme', () => {
    const cfg = loadConfig({ ...FULL_ENV, DELIVERY_URL: 'media.example.com' })

    expect(cfg.problems.some((p) => p.includes('DELIVERY_URL'))).toBe(true)
    expect(cfg.deliveryUrl).toBeNull()
    expect(cfg.checks.delivery).toBe(false)
  })

  it('treats a missing delivery URL as advisory, not a ready blocker', () => {
    const cfg = loadConfig({ ...FULL_ENV, DELIVERY_URL: undefined })

    expect(cfg.ready).toBe(true)
    expect(cfg.checks.delivery).toBe(false)
    expect(cfg.advisories.some((a) => a.includes('DELIVERY_URL'))).toBe(true)
  })

  it('never coerces a missing secret into the string "undefined"', () => {
    const cfg = loadConfig({ ...FULL_ENV, JWT_SECRET: undefined })

    expect(cfg.jwtSecret).toBeNull()
    expect(cfg.problems.some((p) => p.includes('JWT_SECRET'))).toBe(true)
  })

  it('requires the transcoder URL and an ingest secret together', () => {
    const withUrlNoSecret = loadConfig({
      ...FULL_ENV,
      TRANSCODE_INGEST_SECRET: undefined,
      MODAL_WEBHOOK_SECRET: undefined,
    })
    expect(withUrlNoSecret.checks.transcoder).toBe(false)
    expect(withUrlNoSecret.problems.some((p) => p.includes('TRANSCODE_INGEST_SECRET'))).toBe(true)

    const withSecretNoUrl = loadConfig({ ...FULL_ENV, MODAL_WEBHOOK_URL: undefined })
    expect(withSecretNoUrl.checks.transcoder).toBe(false)
    expect(withSecretNoUrl.problems.some((p) => p.includes('MODAL_WEBHOOK_URL'))).toBe(true)
  })

  it('accepts MODAL_WEBHOOK_SECRET as ingest-secret fallback', () => {
    const cfg = loadConfig({
      ...FULL_ENV,
      TRANSCODE_INGEST_SECRET: undefined,
      MODAL_WEBHOOK_SECRET: 'modal-secret',
    })

    expect(cfg.checks.transcoder).toBe(true)
  })
})

describe('requirePlaybackJwtSecret', () => {
  const previous = { ...process.env }

  afterEach(() => {
    process.env = { ...previous }
  })

  it('throws when JWT_SECRET is missing instead of signing with "undefined"', () => {
    delete process.env.JWT_SECRET
    expect(() => requirePlaybackJwtSecret()).toThrow(/JWT_SECRET/)
  })

  it('throws on short JWT_SECRET values', () => {
    process.env.JWT_SECRET = 'short'
    expect(() => requirePlaybackJwtSecret()).toThrow(/JWT_SECRET/)
  })

  it('returns the configured secret', () => {
    process.env.JWT_SECRET = FULL_ENV.JWT_SECRET
    expect(requirePlaybackJwtSecret()).toBe(FULL_ENV.JWT_SECRET)
  })

  it('prefers an explicit env argument over process.env', () => {
    process.env.JWT_SECRET = FULL_ENV.JWT_SECRET
    expect(requirePlaybackJwtSecret({ JWT_SECRET: 'explicit-env-secret-12345678901234567890' })).toBe(
      'explicit-env-secret-12345678901234567890',
    )
  })
})

describe('readDeliveryBaseUrl', () => {
  it('returns null when unconfigured (no placeholder)', () => {
    const previous = process.env.DELIVERY_URL
    delete process.env.DELIVERY_URL
    delete process.env.DELIVERY_WORKER_URL
    expect(readDeliveryBaseUrl()).toBeNull()
    process.env.DELIVERY_URL = previous
  })

  it('prefers DELIVERY_URL over the legacy DELIVERY_WORKER_URL', () => {
    const cfg = loadConfig({ ...FULL_ENV, DELIVERY_WORKER_URL: 'https://legacy.example.com' })
    expect(cfg.deliveryUrl).toBe('https://media.example.com')
  })

  it('accepts DELIVERY_WORKER_URL as a fallback when DELIVERY_URL is unset', () => {
    const cfg = loadConfig({
      ...FULL_ENV,
      DELIVERY_URL: undefined,
      DELIVERY_WORKER_URL: 'https://media.example.com',
    })
    expect(cfg.deliveryUrl).toBe('https://media.example.com')
  })

  it('trailing slashes are stripped', () => {
    const cfg = loadConfig({ ...FULL_ENV, DELIVERY_URL: 'https://media.example.com///' })
    expect(cfg.deliveryUrl).toBe('https://media.example.com')
  })
})

describe('maxUploadBytes', () => {
  it('defaults to 25 GiB when unset or invalid', () => {
    expect(maxUploadBytes({})).toBe(DEFAULT_MAX_UPLOAD_BYTES)
    expect(maxUploadBytes({ MAX_UPLOAD_SIZE_BYTES: 'not-a-number' })).toBe(
      DEFAULT_MAX_UPLOAD_BYTES,
    )
    expect(maxUploadBytes({ MAX_UPLOAD_SIZE_BYTES: '-5' })).toBe(
      DEFAULT_MAX_UPLOAD_BYTES,
    )
  })

  it('uses a configured positive value', () => {
    expect(maxUploadBytes({ MAX_UPLOAD_SIZE_BYTES: String(2 * 1024 ** 3) })).toBe(
      2 * 1024 ** 3,
    )
  })
})
