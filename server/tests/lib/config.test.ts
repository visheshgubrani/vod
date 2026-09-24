import { describe, expect, it } from 'vitest'
import {
  loadConfig,
  requirePlaybackJwtSecret,
  maxUploadBytes,
  DEFAULT_MAX_UPLOAD_BYTES,
  loadProviderSettings,
  requiresRawBucket,
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
      rawUploads: true,
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
  it('throws when JWT_SECRET is missing instead of signing with "undefined"', () => {
    expect(() => requirePlaybackJwtSecret(loadConfig({}))).toThrow(/JWT_SECRET/)
  })

  it('throws on short JWT_SECRET values', () => {
    expect(() =>
      requirePlaybackJwtSecret(loadConfig({ ...FULL_ENV, JWT_SECRET: 'short' })),
    ).toThrow(/JWT_SECRET/)
  })

  it('returns the configured secret', () => {
    expect(requirePlaybackJwtSecret(loadConfig(FULL_ENV))).toBe(FULL_ENV.JWT_SECRET)
  })

  it('reads only the config it is given, never the ambient environment', () => {
    // The accessor used to merge `{...process.env, ...env}`, so a handler could
    // sign with whatever happened to be in the process environment. There is
    // deliberately no ambient path left to test — this asserts its absence.
    const previous = process.env.JWT_SECRET
    process.env.JWT_SECRET = 'ambient-secret-that-must-be-ignored-000000'
    try {
      expect(() => requirePlaybackJwtSecret(loadConfig({}))).toThrow(/JWT_SECRET/)
      expect(requirePlaybackJwtSecret(loadConfig(FULL_ENV))).toBe(FULL_ENV.JWT_SECRET)
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET
      else process.env.JWT_SECRET = previous
    }
  })
})

describe('delivery base URL', () => {
  it('returns null when unconfigured (no placeholder)', () => {
    expect(loadConfig({}).deliveryUrl).toBeNull()
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

// ────────────────────────────────────────────────────────────────────────────
// Provider selection and the conditional raw bucket.
//
// The v1 commitment being pinned here: a local-only installation needs no raw
// bucket, no Modal account and no QStash — while an existing Modal installation
// that sets nothing new keeps exactly the behaviour it had.
// ────────────────────────────────────────────────────────────────────────────
describe('loadProviderSettings', () => {
  it('defaults to modal with local submissions enabled', () => {
    expect(loadProviderSettings({})).toEqual({
      transcodeProvider: 'modal',
      localTranscodeEnabled: true,
      problems: [],
    })
  })

  it('accepts local as the deployment provider', () => {
    const settings = loadProviderSettings({ TRANSCODE_PROVIDER: 'local' })
    expect(settings.transcodeProvider).toBe('local')
    expect(settings.localTranscodeEnabled).toBe(true)
  })

  it('keeps local as the canonical provider', () => {
    expect(loadProviderSettings({ TRANSCODE_PROVIDER: 'local' }).transcodeProvider).toBe(
      'local',
    )
  })

  it('supports disabling new local submissions without changing the provider', () => {
    // This is the documented rollback: accepted jobs drain, nothing is cancelled.
    const settings = loadProviderSettings({
      TRANSCODE_PROVIDER: 'local',
      LOCAL_TRANSCODE_ENABLED: 'false',
    })
    expect(settings.transcodeProvider).toBe('local')
    expect(settings.localTranscodeEnabled).toBe(false)
  })

  it('rejects an unknown provider instead of silently defaulting', () => {
    const settings = loadProviderSettings({ TRANSCODE_PROVIDER: 'lambda' })
    expect(settings.transcodeProvider).toBe('modal')
    expect(settings.problems[0]).toContain('TRANSCODE_PROVIDER')
  })
})

describe('requiresRawBucket', () => {
  it('is not required for a local-only installation', () => {
    expect(
      requiresRawBucket({
        transcodeProvider: 'local',
        uploadsEnabled: false,
        hasRawBucket: false,
      }),
    ).toBe(false)
  })

  it('is required when uploads are enabled', () => {
    expect(
      requiresRawBucket({
        transcodeProvider: 'local',
        uploadsEnabled: true,
        hasRawBucket: false,
      }),
    ).toBe(true)
  })

  it('is required for the Modal provider', () => {
    expect(
      requiresRawBucket({
        transcodeProvider: 'modal',
        uploadsEnabled: false,
        hasRawBucket: false,
      }),
    ).toBe(true)
  })

  it('is satisfied once a bucket exists', () => {
    expect(
      requiresRawBucket({
        transcodeProvider: 'modal',
        uploadsEnabled: true,
        hasRawBucket: true,
      }),
    ).toBe(true)
  })
})

describe('loadConfig with a local provider', () => {
  const LOCAL_ONLY = {
    DATABASE_URL: 'postgresql://user:pass@host:5432/db',
    BETTER_AUTH_SECRET: 'b'.repeat(40),
    JWT_SECRET: 'j'.repeat(40),
    ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    TRANSCODED_BUCKET_NAME: 'clipmux-transcoded',
    TRANSCODE_PROVIDER: 'local',
    LOCAL_TRANSCODER_SECRET: 'local-worker-secret-32-characters-long',
    UPLOADS_ENABLED: 'false',
    DELIVERY_URL: 'https://delivery.example.com',
  }

  it('is ready with no raw bucket and no Modal configuration', () => {
    const cfg = loadConfig(LOCAL_ONLY)
    expect(cfg.ready).toBe(true)
    expect(cfg.checks.rawUploads).toBe(false)
    expect(cfg.rawBucketRequired).toBe(false)
    expect(cfg.checks.transcoder).toBe(true)
  })

  it('says the missing bucket is not needed rather than reporting it missing', () => {
    const cfg = loadConfig(LOCAL_ONLY)
    expect(cfg.problems.some((p) => p.includes('RAW_BUCKET_NAME'))).toBe(false)
    expect(cfg.advisories.some((a) => a.includes('not required'))).toBe(true)
  })

  it('requires the raw bucket again as soon as uploads are enabled', () => {
    const cfg = loadConfig({ ...LOCAL_ONLY, UPLOADS_ENABLED: 'true' })
    expect(cfg.ready).toBe(false)
    expect(cfg.rawBucketRequired).toBe(true)
    expect(cfg.problems.some((p) => p.includes('RAW_BUCKET_NAME'))).toBe(true)
  })

  it('requires Modal configuration again when Modal is the provider', () => {
    const cfg = loadConfig({ ...LOCAL_ONLY, TRANSCODE_PROVIDER: 'modal' })
    expect(cfg.ready).toBe(false)
    expect(cfg.problems.some((p) => p.includes('MODAL_WEBHOOK_URL'))).toBe(true)
  })

  it('notes a stale Modal endpoint that is configured but unused', () => {
    const cfg = loadConfig({ ...LOCAL_ONLY, MODAL_WEBHOOK_URL: 'https://modal.example.com' })
    expect(cfg.ready).toBe(true)
    expect(cfg.advisories.some((a) => a.includes('MODAL_WEBHOOK_URL is configured'))).toBe(true)
  })

  it('reports local transcoding as off when submissions are disabled', () => {
    const cfg = loadConfig({ ...LOCAL_ONLY, LOCAL_TRANSCODE_ENABLED: 'false' })
    expect(cfg.checks.transcoder).toBe(false)
  })
})

/**
 * Where the transcoder sends its result callback.
 *
 * Modal runs in Cloudflare's cloud, so the callback URL has to be reachable from
 * outside this machine. The dispatch path falls back to `http://localhost:8787`
 * when `BACKEND_URL` is unset, and a local development setup that forgets the
 * tunnel URL produces the worst kind of failure: every job runs to completion
 * (GPU time spent), the callback fails, and the video sits in `processing` until
 * the sweeper spends another GPU run on it. The advisory must say so without
 * echoing a host into the public `GET /health/config` projection.
 */
describe('loadConfig transcode callback reachability', () => {
  const MODAL_ENV = { ...FULL_ENV, TRANSCODE_PROVIDER: 'modal' }

  it('warns when BACKEND_URL is unset', () => {
    const cfg = loadConfig(MODAL_ENV)
    expect(cfg.advisories.some((a) => a.includes('BACKEND_URL'))).toBe(true)
  })

  it('warns when BACKEND_URL is a loopback address', () => {
    for (const backendUrl of [
      'http://localhost:8787',
      'http://127.0.0.1:8787',
      'http://[::1]:8787',
    ]) {
      const cfg = loadConfig({ ...MODAL_ENV, BACKEND_URL: backendUrl })
      expect(
        cfg.advisories.some((a) => a.includes('BACKEND_URL')),
        backendUrl,
      ).toBe(true)
    }
  })

  it('stays quiet when BACKEND_URL is publicly reachable', () => {
    const cfg = loadConfig({ ...MODAL_ENV, BACKEND_URL: 'https://clipmux-dev.ngrok-free.app' })
    expect(cfg.advisories.some((a) => a.includes('BACKEND_URL'))).toBe(false)
  })

  it('does not say anything when no Modal worker will call back', () => {
    const cfg = loadConfig({ ...MODAL_ENV, TRANSCODE_PROVIDER: 'local' })
    expect(cfg.advisories.some((a) => a.includes('BACKEND_URL'))).toBe(false)
  })

  it('keeps the configured URL out of the public health projection', () => {
    const cfg = loadConfig({ ...MODAL_ENV, BACKEND_URL: 'http://127.0.0.1:9999' })
    const advisory = cfg.advisories.find((a) => a.includes('BACKEND_URL')) ?? ''
    expect(advisory).not.toContain('127.0.0.1')
    expect(advisory).not.toContain('9999')
  })
})
