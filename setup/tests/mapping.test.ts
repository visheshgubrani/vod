import { describe, expect, it } from 'vitest'
import type { SecretSet, WizardAnswers } from '../src/types'
import {
  buildDeployConfig,
  buildDeliveryEntries,
  buildDevConfig,
  databaseUrlFor,
  deriveAnswersFromConfig,
  deriveAnswersFromEnv,
  SERVER_KEY_ORDER,
  DEPLOY_KEY_ORDER,
  needsRawBucket,
  validateAnswers,
  validateChoices,
  validateCredentials,
  applyHostInstallSettings,
  isHostInstallConfigured,
} from '../src/mapping'
import { parsePublicOrigin, proxySettingsFor, urlsFromOrigin } from '../src/origin'

const SECRETS: SecretSet = {
  betterAuthSecret: 'a'.repeat(64),
  jwtSecret: 'b'.repeat(64),
  internalSweepSecret: 'c'.repeat(64),
  transcodeIngestSecret: 'd'.repeat(64),
  localTranscoderSecret: 'g'.repeat(64),
  analyticsIngestSecret: 'f'.repeat(64),
  postgresPassword: 'e'.repeat(48),
}

export function nodeAnswers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    db: { kind: 'existing', url: 'postgresql://user:pass@db.example.com/vod?sslmode=require' },
    queue: { kind: 'direct' },
    rateLimit: { kind: 'memory' },
    accountId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    r2AccessKeyId: 'r2-access-key',
    r2SecretAccessKey: 'r2-secret-key',
    rawBucket: 'clipmux-raw',
    transcodedBucket: 'clipmux-transcoded',
    frontendUrl: 'http://localhost:3000',
    ...overrides,
  }
}

describe('validateAnswers', () => {
  it('accepts a valid existing-Postgres answers object', () => {
    expect(validateAnswers(nodeAnswers())).toEqual([])
  })

  it('rejects obsolete db.kind neon with a clear removal message', () => {
    const answers = nodeAnswers({ db: { kind: 'neon' as never, url: 'postgresql://x/y' } })
    expect(validateAnswers(answers).some((p) => p.includes('no longer a wizard choice'))).toBe(true)
  })

  it('rejects existing without a postgres URL', () => {
    const answers = nodeAnswers({ db: { kind: 'existing', url: 'mysql://x' } })
    expect(validateAnswers(answers).some((p) => p.includes('postgres'))).toBe(true)
  })

  it('accepts local and existing Postgres', () => {
    expect(validateAnswers(nodeAnswers({ db: { kind: 'local' } }))).toEqual([])
    expect(
      validateAnswers(
        nodeAnswers({ db: { kind: 'existing', url: 'postgresql://db.example.com:5432/vod' } }),
      ),
    ).toEqual([])
  })

  it('accepts a plain Redis URL', () => {
    expect(
      validateAnswers(
        nodeAnswers({
          db: { kind: 'local' },
          rateLimit: { kind: 'redis', url: 'redis://localhost:6379' },
        }),
      ),
    ).toEqual([])
  })

  it('requires a redis:// URL for the redis store', () => {
    const answers = nodeAnswers({
      db: { kind: 'local' },
      rateLimit: { kind: 'redis', url: 'localhost:6379' },
    })
    expect(validateAnswers(answers).some((p) => p.includes('rateLimit.url'))).toBe(true)
  })

  it('requires a token for qstash and url+token for upstash', () => {
    expect(
      validateAnswers(nodeAnswers({ queue: { kind: 'qstash' } })).some((p) =>
        p.includes('queue.token'),
      ),
    ).toBe(true)
    expect(validateAnswers(nodeAnswers({ queue: { kind: 'qstash', token: 'qst_123' } }))).toEqual([])
    expect(
      validateAnswers(
        nodeAnswers({ rateLimit: { kind: 'upstash', restUrl: 'https://x.upstash.io' } }),
      ).some((p) => p.includes('rateLimit.token')),
    ).toBe(true)
    expect(
      validateAnswers(
        nodeAnswers({
          rateLimit: { kind: 'upstash', restUrl: 'https://x.upstash.io', token: 'tok' },
        }),
      ),
    ).toEqual([])
  })

  it('requires credentials and a frontend URL', () => {
    const problems = validateAnswers(
      nodeAnswers({ accountId: '', r2AccessKeyId: '', frontendUrl: 'not a url' }),
    )
    expect(problems).toContain('accountId is required')
    expect(problems).toContain('r2AccessKeyId is required')
    expect(problems.some((p) => p.includes('frontendUrl'))).toBe(true)
  })
})

describe('mapping to env entries', () => {
  it('maps existing Postgres + direct + memory to the expected keys', () => {
    const entries = new Map(buildDevConfig(nodeAnswers(), SECRETS))
    expect(entries.has('DB_DRIVER')).toBe(false)
    expect(entries.get('DATABASE_URL')).toContain('db.example.com')
    expect(entries.get('QSTASH_TOKEN')).toBe('')
    expect(entries.get('UPSTASH_REDIS_REST_URL')).toBe('')
    expect(entries.get('UPSTASH_REDIS_REST_TOKEN')).toBe('')
    expect(entries.get('BETTER_AUTH_URL')).toBe('http://localhost:8787')
    expect(entries.get('DELIVERY_URL')).toBe('')
    expect(entries.get('MODAL_WEBHOOK_URL')).toBe('')
    expect(entries.get('JWT_SECRET')).toBe(SECRETS.jwtSecret)
    expect(entries.get('ANALYTICS_ENABLED')).toBe('true')
    expect(entries.get('ANALYTICS_INGEST_SECRET')).toBe(SECRETS.analyticsIngestSecret)
    expect(entries.get('SWEEP_ENABLED')).toBe('true')
    expect(entries.get('MAINTENANCE_INTERVAL_SECONDS')).toBe('900')
    expect(entries.get('GROQ_API_KEY')).toBe('')
    expect(entries.get('ACCOUNT_ID')).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
  })

  it('maps local Postgres to the dev Postgres URL', () => {
    const entries = new Map(buildDevConfig(nodeAnswers({ db: { kind: 'local' } }), SECRETS))
    expect(entries.get('DATABASE_URL')).toBe(
      'postgresql://postgres:postgres@localhost:5433/vod_dev',
    )
  })

  it('writes a deployment .env that leaves the bundled services in charge', () => {
    const entries = new Map(buildDeployConfig(nodeAnswers({ db: { kind: 'local' } }), SECRETS))

    expect(entries.get('DATABASE_URL')).toBe('')
    expect(entries.get('REDIS_URL')).toBe('')
    expect(entries.has('DB_DRIVER')).toBe(false)
    expect(entries.get('POSTGRES_PASSWORD')).toBe(SECRETS.postgresPassword)
    expect(entries.get('JWT_SECRET')).toBe(SECRETS.jwtSecret)
    expect(entries.get('SWEEP_ENABLED')).toBe('true')
    expect(entries.get('TRANSCODE_PROVIDER')).toBe('local')
    expect(entries.get('ANALYTICS_ENABLED')).toBe('true')
  })

  it('points a deployment .env at an external Postgres when one was chosen', () => {
    const entries = new Map(
      buildDeployConfig(
        nodeAnswers({ db: { kind: 'existing', url: 'postgresql://db.example.com:5432/clipmux' } }),
        SECRETS,
      ),
    )
    expect(entries.get('DATABASE_URL')).toBe('postgresql://db.example.com:5432/clipmux')
  })

  it('carries a plain-Redis choice into the deployment .env, and blanks Upstash', () => {
    const entries = new Map(
      buildDeployConfig(
        nodeAnswers({
          db: { kind: 'local' },
          rateLimit: { kind: 'redis', url: 'redis://cache.internal:6379' },
        }),
        SECRETS,
      ),
    )
    expect(entries.get('REDIS_URL')).toBe('redis://cache.internal:6379')
    expect(entries.get('UPSTASH_REDIS_REST_URL')).toBe('')
  })

  it('maps qstash and upstash choices into their keys', () => {
    const entries = new Map(
      buildDevConfig(
        nodeAnswers({
          queue: { kind: 'qstash', token: 'qst_abc' },
          rateLimit: { kind: 'upstash', restUrl: 'https://x.upstash.io', token: 'tok_1' },
          groqApiKey: 'gsk_key',
        }),
        SECRETS,
      ),
    )
    expect(entries.get('QSTASH_TOKEN')).toBe('qst_abc')
    expect(entries.get('UPSTASH_REDIS_REST_URL')).toBe('https://x.upstash.io')
    expect(entries.get('UPSTASH_REDIS_REST_TOKEN')).toBe('tok_1')
    expect(entries.get('GROQ_API_KEY')).toBe('gsk_key')
  })

  it('never writes placeholder values for generated secrets', () => {
    const entries = new Map(buildDevConfig(nodeAnswers(), SECRETS))
    const secretKeys: Array<[envKey: string, value: string]> = [
      ['BETTER_AUTH_SECRET', SECRETS.betterAuthSecret],
      ['JWT_SECRET', SECRETS.jwtSecret],
      ['TRANSCODE_INGEST_SECRET', SECRETS.transcodeIngestSecret],
      ['INTERNAL_SWEEP_SECRET', SECRETS.internalSweepSecret],
      ['ANALYTICS_INGEST_SECRET', SECRETS.analyticsIngestSecret],
    ]
    for (const [envKey, secretValue] of secretKeys) {
      expect(entries.get(envKey)).toBe(secretValue)
      expect(secretValue.length).toBeGreaterThanOrEqual(32)
    }
  })

  it('omits the ingest secret when analytics are off', () => {
    const entries = new Map(
      buildDevConfig(nodeAnswers({ analyticsEnabled: false }), SECRETS),
    )
    expect(entries.get('ANALYTICS_ENABLED')).toBe('false')
    expect(entries.get('ANALYTICS_INGEST_SECRET')).toBe('')
    const delivery = new Map(buildDeliveryEntries(SECRETS, { analyticsEnabled: false }))
    expect(delivery.get('ANALYTICS_ENABLED')).toBe('false')
    expect(delivery.get('ANALYTICS_INGEST_SECRET')).toBe('')
  })

  it('builds the delivery file with the mirrored JWT and ingest secret', () => {
    const entries = new Map(buildDeliveryEntries(SECRETS, { analyticsEnabled: true }))
    expect(entries.get('JWT_SECRET')).toBe(SECRETS.jwtSecret)
    expect(entries.get('DEFAULT_POLICY')).toBe('public')
    expect(entries.get('DELIVERY_DEBUG')).toBe('false')
    expect(entries.get('ANALYTICS_ENABLED')).toBe('true')
    expect(entries.get('ANALYTICS_INGEST_SECRET')).toBe(SECRETS.analyticsIngestSecret)
  })
})

describe('deriveAnswersFromEnv', () => {
  it('round-trips an existing-Postgres env back into answers', () => {
    const original = nodeAnswers({ queue: { kind: 'qstash', token: 'qst_9' } })
    const entries = new Map(buildDevConfig(original, SECRETS))
    const derived = deriveAnswersFromEnv(Object.fromEntries(entries))
    expect(derived.db.kind).toBe('existing')
    expect(derived.db.url).toBe(original.db.url)
    expect(derived.queue.kind).toBe('qstash')
    expect(derived.queue.token).toBe('qst_9')
    expect(derived.analyticsEnabled).toBe(true)
  })

  it('treats the default compose URL as kind local', () => {
    const env: Record<string, string> = {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/vod_dev',
    }
    expect(deriveAnswersFromEnv(env).db).toEqual({ kind: 'local' })
  })
})

describe('helpers', () => {
  it('derives the DATABASE_URL from the chosen Postgres', () => {
    expect(databaseUrlFor({ kind: 'local' })).toBe(
      'postgresql://postgres:postgres@localhost:5433/vod_dev',
    )
    expect(databaseUrlFor({ kind: 'existing', url: ' postgresql://x/y ' })).toBe('postgresql://x/y')
  })
})

describe('the transcoder provider', () => {
  it('keeps the provider flags in the canonical key set', () => {
    for (const key of [
      'TRANSCODE_PROVIDER',
      'LOCAL_TRANSCODE_ENABLED',
      'LOCAL_TRANSCODER_SECRET',
      'UPLOADS_ENABLED',
      'ANALYTICS_ENABLED',
      'ANALYTICS_INGEST_SECRET',
    ]) {
      expect(SERVER_KEY_ORDER).toContain(key)
    }
  })

  it('writes the provider and upload flags into both configurations', () => {
    const local = nodeAnswers({
      db: { kind: 'local' },
      transcodeProvider: 'local',
      uploadsEnabled: false,
      rawBucket: 'unused-raw',
    })
    for (const entries of [buildDevConfig(local, SECRETS), buildDeployConfig(local, SECRETS)]) {
      const map = new Map(entries)
      expect(map.get('TRANSCODE_PROVIDER')).toBe('local')
      expect(map.get('UPLOADS_ENABLED')).toBe('false')
      expect(map.get('RAW_BUCKET_NAME')).toBe('')
    }
  })

  it('refuses Modal with uploads off, because Modal ingests from the raw bucket', () => {
    const problems = validateChoices({
      dbKind: 'local',
      transcodeProvider: 'modal',
      uploadsEnabled: false,
      queueKind: 'direct',
      rateLimitKind: 'memory',
    })
    expect(problems.some((p) => p.includes('requires uploads'))).toBe(true)
  })

  it('does not need a raw bucket for a local-only installation', () => {
    const local = nodeAnswers({
      db: { kind: 'local' },
      transcodeProvider: 'local',
      uploadsEnabled: false,
      rawBucket: '',
    })
    expect(needsRawBucket(local)).toBe(false)
    expect(validateCredentials(local).some((p) => p.includes('rawBucket'))).toBe(false)
  })
})

describe('validation stages', () => {
  it('checks compatibility before any credential exists', () => {
    expect(
      validateChoices({
        target: 'dev',
        dbKind: 'existing',
        transcodeProvider: 'modal',
        uploadsEnabled: true,
        queueKind: 'direct',
        rateLimitKind: 'memory',
      }),
    ).toEqual([])
  })

  it('reports missing values only in the credential stage', () => {
    const answers = nodeAnswers({ db: { kind: 'existing' }, accountId: '' })
    expect(
      validateChoices({
        dbKind: 'existing',
        transcodeProvider: 'modal',
        uploadsEnabled: true,
        queueKind: 'direct',
        rateLimitKind: 'memory',
      }),
    ).toEqual([])
    const credentialProblems = validateCredentials(answers)
    expect(credentialProblems.some((p) => p.includes('db.url'))).toBe(true)
    expect(credentialProblems).toContain('accountId is required')
  })
})

describe('deriveAnswersFromConfig', () => {
  it('reads the provider flags back, so --deploy does not resurrect Modal', () => {
    const local = nodeAnswers({
      target: 'dev',
      db: { kind: 'local' },
      transcodeProvider: 'local',
      uploadsEnabled: false,
    })
    const entries = new Map(buildDevConfig(local, SECRETS))
    const derived = deriveAnswersFromConfig('dev', Object.fromEntries(entries))
    expect(derived.transcodeProvider).toBe('local')
    expect(derived.uploadsEnabled).toBe(false)
  })

  it('round-trips the deploy target through the .env builder', () => {
    const deploy = nodeAnswers({
      target: 'deploy',
      db: { kind: 'existing', url: 'postgresql://db.example.com:5432/clipmux' },
      transcodeProvider: 'modal',
      queue: { kind: 'qstash', token: 'qst_7' },
    })
    const entries = new Map(buildDeployConfig(deploy, SECRETS))
    const derived = deriveAnswersFromConfig('deploy', Object.fromEntries(entries))
    expect(derived.target).toBe('deploy')
    expect(derived.db).toEqual({
      kind: 'existing',
      url: 'postgresql://db.example.com:5432/clipmux',
    })
    expect(derived.queue).toEqual({ kind: 'qstash', token: 'qst_7' })
  })

  it('reads a file written before the provider flags existed as modal + uploads on', () => {
    const legacy: Record<string, string> = {
      DATABASE_URL: 'postgresql://user:pass@ep-x.aws.neon.tech/vod',
      ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      RAW_BUCKET_NAME: 'clipmux-raw',
    }
    const derived = deriveAnswersFromConfig('dev', legacy)
    expect(derived.transcodeProvider).toBe('modal')
    expect(derived.uploadsEnabled).toBe(true)
    expect(derived.analyticsEnabled).toBe(true)
  })

  it('treats ANALYTICS_ENABLED=0 as disabled, matching Node and delivery', () => {
    expect(deriveAnswersFromConfig('dev', { ANALYTICS_ENABLED: '0' }).analyticsEnabled).toBe(false)
    expect(deriveAnswersFromConfig('dev', { ANALYTICS_ENABLED: 'false' }).analyticsEnabled).toBe(
      false,
    )
    expect(deriveAnswersFromConfig('dev', { ANALYTICS_ENABLED: '1' }).analyticsEnabled).toBe(true)
    expect(deriveAnswersFromConfig('dev', { ANALYTICS_ENABLED: 'true' }).analyticsEnabled).toBe(true)
    expect(deriveAnswersFromConfig('dev', {}).analyticsEnabled).toBe(true)
  })
})

describe('public origin for a host install', () => {
  it('normalizes localhost and a public HTTPS hostname', () => {
    expect(parsePublicOrigin('http://localhost')).toEqual({
      ok: true,
      origin: 'http://localhost',
      access: 'localhost',
    })
    expect(parsePublicOrigin('HTTP://LocalHost/')).toEqual({
      ok: true,
      origin: 'http://localhost',
      access: 'localhost',
    })
    expect(parsePublicOrigin('https://vod.example.com')).toEqual({
      ok: true,
      origin: 'https://vod.example.com',
      access: 'domain',
    })
    expect(parsePublicOrigin('vod.example.com')).toEqual({
      ok: true,
      origin: 'https://vod.example.com',
      access: 'domain',
    })
  })

  it('rejects credentials, paths, queries and custom ports', () => {
    expect(parsePublicOrigin('https://user:pass@vod.example.com').ok).toBe(false)
    expect(parsePublicOrigin('https://vod.example.com/app').ok).toBe(false)
    expect(parsePublicOrigin('https://vod.example.com?x=1').ok).toBe(false)
    expect(parsePublicOrigin('http://localhost:3000').ok).toBe(false)
    expect(parsePublicOrigin('https://vod.example.com:8443').ok).toBe(false)
    expect(parsePublicOrigin('http://vod.example.com').ok).toBe(false)
  })

  it('derives API, auth and dashboard URLs from the same origin', () => {
    expect(urlsFromOrigin('http://localhost')).toEqual({
      origin: 'http://localhost',
      api: 'http://localhost',
      frontend: 'http://localhost',
      nextApi: 'http://localhost/api',
      nextAuth: 'http://localhost/api/auth',
      cors: 'http://localhost',
    })
    expect(urlsFromOrigin('https://vod.example.com')).toEqual({
      origin: 'https://vod.example.com',
      api: 'https://vod.example.com',
      frontend: 'https://vod.example.com',
      nextApi: 'https://vod.example.com/api',
      nextAuth: 'https://vod.example.com/api/auth',
      cors: 'https://vod.example.com',
    })
  })

  it('binds the proxy to loopback for localhost and to public interfaces for a domain', () => {
    expect(proxySettingsFor({ origin: 'http://localhost', access: 'localhost' })).toEqual({
      enabled: true,
      site: 'http://localhost',
      bindAddress: '127.0.0.1',
      profiles: 'proxy',
    })
    expect(
      proxySettingsFor({ origin: 'https://vod.example.com', access: 'domain' }, 'ops@example.com'),
    ).toEqual({
      enabled: true,
      site: 'vod.example.com',
      acmeEmail: 'ops@example.com',
      bindAddress: '0.0.0.0',
      profiles: 'proxy',
    })
  })
})

describe('host-install mapping', () => {
  it('keeps proxy keys in the canonical deploy set', () => {
    for (const key of [
      'CLIPMUX_HOST_INSTALL',
      'CLIPMUX_CADDY_SITE',
      'CLIPMUX_ACME_EMAIL',
      'CLIPMUX_PROXY_BIND',
      'COMPOSE_PROFILES',
    ]) {
      expect(DEPLOY_KEY_ORDER).toContain(key)
    }
  })

  it('writes localhost host-install URLs through the proxy origin, not :8787/:3000', () => {
    const answers = nodeAnswers({
      target: 'deploy',
      db: { kind: 'local' },
      hostInstall: true,
      access: 'localhost',
      transcodeProvider: 'local',
      frontendUrl: 'http://localhost',
      proxy: proxySettingsFor({ origin: 'http://localhost', access: 'localhost' }),
    })
    const entries = new Map(buildDeployConfig(answers, SECRETS))
    expect(entries.get('FRONTEND_URL')).toBe('http://localhost')
    expect(entries.get('BACKEND_URL')).toBe('http://localhost')
    expect(entries.get('BETTER_AUTH_URL')).toBe('http://localhost')
    expect(entries.get('CORS_ORIGINS')).toBe('http://localhost')
    expect(entries.get('NEXT_PUBLIC_API_BASE_URL')).toBe('http://localhost/api')
    expect(entries.get('NEXT_PUBLIC_AUTH_BASE_URL')).toBe('http://localhost/api/auth')
    expect(entries.get('NEXT_PUBLIC_FRONTEND_URL')).toBe('http://localhost')
    expect(entries.get('CLIPMUX_HOST_INSTALL')).toBe('true')
    expect(entries.get('CLIPMUX_CADDY_SITE')).toBe('http://localhost')
    expect(entries.get('CLIPMUX_PROXY_BIND')).toBe('127.0.0.1')
    expect(entries.get('COMPOSE_PROFILES')).toBe('proxy')
    expect(entries.get('CLIPMUX_API_PORT')).toBe('8787')
    expect(entries.get('CLIPMUX_WEB_PORT')).toBe('3000')
  })

  it('writes a public HTTPS hostname through the same origin', () => {
    const answers = nodeAnswers({
      target: 'deploy',
      db: { kind: 'local' },
      hostInstall: true,
      access: 'domain',
      transcodeProvider: 'modal',
      frontendUrl: 'https://vod.example.com',
      proxy: proxySettingsFor(
        { origin: 'https://vod.example.com', access: 'domain' },
        'ops@example.com',
      ),
    })
    const entries = new Map(buildDeployConfig(answers, SECRETS))
    expect(entries.get('BACKEND_URL')).toBe('https://vod.example.com')
    expect(entries.get('NEXT_PUBLIC_API_BASE_URL')).toBe('https://vod.example.com/api')
    expect(entries.get('CLIPMUX_CADDY_SITE')).toBe('vod.example.com')
    expect(entries.get('CLIPMUX_ACME_EMAIL')).toBe('ops@example.com')
    expect(entries.get('CLIPMUX_PROXY_BIND')).toBe('0.0.0.0')
  })

  it('round-trips host-install proxy settings from the deploy .env', () => {
    const original = nodeAnswers({
      target: 'deploy',
      db: { kind: 'local' },
      hostInstall: true,
      access: 'domain',
      transcodeProvider: 'local',
      frontendUrl: 'https://vod.example.com',
      proxy: proxySettingsFor(
        { origin: 'https://vod.example.com', access: 'domain' },
        'ops@example.com',
      ),
    })
    const entries = new Map(buildDeployConfig(original, SECRETS))
    const derived = deriveAnswersFromConfig('deploy', Object.fromEntries(entries))
    expect(derived.hostInstall).toBe(true)
    expect(derived.access).toBe('domain')
    expect(derived.frontendUrl).toBe('https://vod.example.com')
    expect(derived.proxy).toEqual({
      enabled: true,
      site: 'vod.example.com',
      acmeEmail: 'ops@example.com',
      bindAddress: '0.0.0.0',
      profiles: 'proxy',
    })
  })

  it('leaves ordinary deploy answers on localhost:8787 / :3000', () => {
    const entries = new Map(buildDeployConfig(nodeAnswers({ db: { kind: 'local' } }), SECRETS))
    expect(entries.get('BACKEND_URL')).toBe('http://localhost:8787')
    expect(entries.get('NEXT_PUBLIC_API_BASE_URL')).toBe('http://localhost:8787/api')
    expect(entries.get('FRONTEND_URL')).toBe('http://localhost:3000')
    expect(entries.get('CLIPMUX_HOST_INSTALL')).toBe('')
    expect(entries.get('CLIPMUX_CADDY_SITE')).toBe('')
    expect(entries.get('COMPOSE_PROFILES')).toBe('')
  })

  it('does not treat a legacy answers file as a host install', () => {
    const derived = deriveAnswersFromConfig('deploy', {
      FRONTEND_URL: 'http://localhost:3000',
      BACKEND_URL: 'http://localhost:8787',
    })
    expect(derived.hostInstall).toBeUndefined()
    expect(derived.proxy).toBeUndefined()
    expect(derived.frontendUrl).toBe('http://localhost:3000')
    expect(isHostInstallConfigured({ FRONTEND_URL: 'http://localhost:3000' })).toBe(false)
  })

  it('overlays host-install access onto an existing deploy config without dropping credentials', () => {
    const existing = deriveAnswersFromConfig('deploy', {
      FRONTEND_URL: 'http://localhost:3000',
      BACKEND_URL: 'http://localhost:8787',
      ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      R2_ACCESS_KEY_ID: 'r2-access-key',
      R2_SECRET_ACCESS_KEY: 'r2-secret-key',
      TRANSCODED_BUCKET_NAME: 'clipmux-transcoded',
      TRANSCODE_PROVIDER: 'modal',
    })
    const overlaid = applyHostInstallSettings(existing, {
      access: 'localhost',
      origin: 'http://localhost',
    })
    expect(overlaid.hostInstall).toBe(true)
    expect(overlaid.access).toBe('localhost')
    expect(overlaid.frontendUrl).toBe('http://localhost')
    expect(overlaid.r2AccessKeyId).toBe('r2-access-key')
    expect(overlaid.accountId).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(overlaid.transcodeProvider).toBe('local')
    expect(overlaid.proxy).toEqual({
      enabled: true,
      site: 'http://localhost',
      bindAddress: '127.0.0.1',
      profiles: 'proxy',
    })
  })

  it('rejects localhost + Modal before provisioning', () => {
    const problems = validateChoices({
      target: 'deploy',
      dbKind: 'local',
      hostInstall: true,
      access: 'localhost',
      transcodeProvider: 'modal',
      uploadsEnabled: true,
      queueKind: 'direct',
      rateLimitKind: 'memory',
    })
    expect(problems.some((p) => p.includes('localhost installations cannot use Modal'))).toBe(true)
  })

  it('allows a public HTTPS hostname with Modal', () => {
    expect(
      validateChoices({
        target: 'deploy',
        dbKind: 'local',
        hostInstall: true,
        access: 'domain',
        transcodeProvider: 'modal',
        uploadsEnabled: true,
        queueKind: 'direct',
        rateLimitKind: 'memory',
      }),
    ).toEqual([])
  })
})
