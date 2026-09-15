import { describe, expect, it } from 'vitest'
import type { SecretSet, WizardAnswers } from '../src/types'
import {
  buildDeployConfig,
  buildDeliveryEntries,
  buildDevConfig,
  databaseUrlFor,
  dbDriverFor,
  deriveAnswersFromConfig,
  deriveAnswersFromEnv,
  SERVER_KEY_ORDER,
  needsRawBucket,
  selfHostedEnabledValue,
  validateAnswers,
  validateChoices,
  validateCredentials,
} from '../src/mapping'

const SECRETS: SecretSet = {
  betterAuthSecret: 'a'.repeat(64),
  jwtSecret: 'b'.repeat(64),
  internalSweepSecret: 'c'.repeat(64),
  transcodeIngestSecret: 'd'.repeat(64),
  postgresPassword: 'e'.repeat(48),
}

export function workersAnswers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    runtime: 'workers',
    db: { kind: 'neon', url: 'postgresql://user:pass@ep-test.aws.neon.tech/vod?sslmode=require' },
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
  it('accepts a valid workers + neon answers object', () => {
    expect(validateAnswers(workersAnswers())).toEqual([])
  })

  it('rejects workers runtime with a non-neon database', () => {
    const answers = workersAnswers({ db: { kind: 'local' } })
    expect(validateAnswers(answers)).toEqual([
      'runtime "workers" requires db.kind "neon" (the neon-http driver)',
    ])
  })

  it('rejects neon without a postgres URL', () => {
    const answers = workersAnswers({ db: { kind: 'neon', url: 'mysql://x' } })
    expect(validateAnswers(answers).some((p) => p.includes('postgres'))).toBe(true)
  })

  it('accepts node + local and node + existing', () => {
    // 'compose' was renamed to 'node': the runtime is a separate decision from
    // the Docker deployment shape.
    const local = workersAnswers({
      runtime: 'node',
      db: { kind: 'local' },
      queue: { kind: 'direct' },
    })
    expect(validateAnswers(local)).toEqual([])

    const existing = workersAnswers({
      runtime: 'node',
      db: { kind: 'existing', url: 'postgresql://db.example.com:5432/vod' },
    })
    expect(validateAnswers(existing)).toEqual([])
  })

  it('rejects node + neon (pg driver cannot use neon-http)', () => {
    const answers = workersAnswers({ runtime: 'node', db: { kind: 'neon' } })
    expect(validateAnswers(answers).some((p) => p.includes('node'))).toBe(true)
  })

  it('accepts a plain Redis on node and refuses it on workers', () => {
    const onNode = workersAnswers({
      runtime: 'node',
      db: { kind: 'local' },
      rateLimit: { kind: 'redis', url: 'redis://localhost:6379' },
    })
    expect(validateAnswers(onNode)).toEqual([])

    // A TCP socket is impossible on Workers, so this is a refusal rather than a
    // silent downgrade to per-isolate limits.
    const onWorkers = workersAnswers({
      rateLimit: { kind: 'redis', url: 'redis://localhost:6379' },
    })
    expect(validateAnswers(onWorkers).some((p) => p.includes('not available on the Workers'))).toBe(
      true,
    )
  })

  it('requires a redis:// URL for the redis store', () => {
    const answers = workersAnswers({
      runtime: 'node',
      db: { kind: 'local' },
      rateLimit: { kind: 'redis', url: 'localhost:6379' },
    })
    expect(validateAnswers(answers).some((p) => p.includes('rateLimit.url'))).toBe(true)
  })

  it('requires a token for qstash and url+token for upstash', () => {
    expect(
      validateAnswers(workersAnswers({ queue: { kind: 'qstash' } })).some((p) =>
        p.includes('queue.token'),
      ),
    ).toBe(true)
    expect(
      validateAnswers(workersAnswers({ queue: { kind: 'qstash', token: 'qst_123' } })),
    ).toEqual([])
    expect(
      validateAnswers(
        workersAnswers({ rateLimit: { kind: 'upstash', restUrl: 'https://x.upstash.io' } }),
      ).some((p) => p.includes('rateLimit.token')),
    ).toBe(true)
    expect(
      validateAnswers(
        workersAnswers({
          rateLimit: { kind: 'upstash', restUrl: 'https://x.upstash.io', token: 'tok' },
        }),
      ),
    ).toEqual([])
  })

  it('requires credentials and a frontend URL', () => {
    const problems = validateAnswers(
      workersAnswers({ accountId: '', r2AccessKeyId: '', frontendUrl: 'not a url' }),
    )
    expect(problems).toContain('accountId is required')
    expect(problems).toContain('r2AccessKeyId is required')
    expect(problems.some((p) => p.includes('frontendUrl'))).toBe(true)
  })
})

describe('mapping to env entries', () => {
  it('maps workers + neon + direct + memory to the expected keys', () => {
    const entries = new Map(buildDevConfig(workersAnswers(), SECRETS))
    expect(entries.get('DB_DRIVER')).toBe('neon-http')
    expect(entries.get('DATABASE_URL')).toContain('ep-test.aws.neon.tech')
    expect(entries.get('QSTASH_TOKEN')).toBe('')
    expect(entries.get('UPSTASH_REDIS_REST_URL')).toBe('')
    expect(entries.get('UPSTASH_REDIS_REST_TOKEN')).toBe('')
    expect(entries.get('BETTER_AUTH_URL')).toBe('http://localhost:8787')
    expect(entries.get('DELIVERY_URL')).toBe('')
    expect(entries.get('MODAL_WEBHOOK_URL')).toBe('')
    expect(entries.get('JWT_SECRET')).toBe(SECRETS.jwtSecret)
    expect(entries.get('GROQ_API_KEY')).toBe('')
    expect(entries.get('ACCOUNT_ID')).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
  })

  it('maps node + local to pg + the dev Postgres URL', () => {
    const entries = new Map(
      buildDevConfig(
        workersAnswers({ runtime: 'node', db: { kind: 'local' } }),
        SECRETS,
      ),
    )
    expect(entries.get('DB_DRIVER')).toBe('pg')
    expect(entries.get('DATABASE_URL')).toBe('postgresql://postgres:postgres@localhost:5433/vod_dev')
  })

  it('writes a deployment .env that leaves the bundled services in charge', () => {
    const entries = new Map(
      buildDeployConfig(
        workersAnswers({ runtime: 'node', db: { kind: 'local' } }),
        SECRETS,
      ),
    )

    // Blank means "use the bundled service": the compose file composes
    // DATABASE_URL from POSTGRES_* and REDIS_URL from the redis service.
    expect(entries.get('DATABASE_URL')).toBe('')
    expect(entries.get('REDIS_URL')).toBe('')
    expect(entries.get('DB_DRIVER')).toBe('pg')
    expect(entries.get('POSTGRES_PASSWORD')).toBe(SECRETS.postgresPassword)
    expect(entries.get('JWT_SECRET')).toBe(SECRETS.jwtSecret)
    expect(entries.get('SWEEP_ENABLED')).toBe('true')
    expect(entries.get('TRANSCODE_PROVIDER')).toBe('modal')
  })

  it('points a deployment .env at an external Postgres when one was chosen', () => {
    const entries = new Map(
      buildDeployConfig(
        workersAnswers({
          runtime: 'node',
          db: { kind: 'existing', url: 'postgresql://db.example.com:5432/clipmux' },
        }),
        SECRETS,
      ),
    )
    expect(entries.get('DATABASE_URL')).toBe('postgresql://db.example.com:5432/clipmux')
  })

  it('carries a plain-Redis choice into the deployment .env, and blanks Upstash', () => {
    const entries = new Map(
      buildDeployConfig(
        workersAnswers({
          runtime: 'node',
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
        workersAnswers({
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
    const entries = new Map(buildDevConfig(workersAnswers(), SECRETS))
    const secretKeys: Array<[envKey: string, value: string]> = [
      ['BETTER_AUTH_SECRET', SECRETS.betterAuthSecret],
      ['JWT_SECRET', SECRETS.jwtSecret],
      ['TRANSCODE_INGEST_SECRET', SECRETS.transcodeIngestSecret],
      ['INTERNAL_SWEEP_SECRET', SECRETS.internalSweepSecret],
    ]
    for (const [envKey, secretValue] of secretKeys) {
      expect(entries.get(envKey)).toBe(secretValue)
      expect(secretValue.length).toBeGreaterThanOrEqual(32)
    }
  })

  it('builds the delivery file with the mirrored JWT', () => {
    const entries = new Map(buildDeliveryEntries(SECRETS))
    expect(entries.get('JWT_SECRET')).toBe(SECRETS.jwtSecret)
    expect(entries.get('DEFAULT_POLICY')).toBe('public')
    expect(entries.get('DELIVERY_DEBUG')).toBe('false')
  })
})

describe('deriveAnswersFromEnv', () => {
  it('round-trips a workers env back into answers', () => {
    const original = workersAnswers({ queue: { kind: 'qstash', token: 'qst_9' } })
    const entries = new Map(buildDevConfig(original, SECRETS))
    const derived = deriveAnswersFromEnv(Object.fromEntries(entries))
    expect(derived.runtime).toBe('workers')
    expect(derived.db.kind).toBe('neon')
    expect(derived.db.url).toBe(original.db.url)
    expect(derived.queue.kind).toBe('qstash')
    expect(derived.queue.token).toBe('qst_9')
  })

  it('treats the default compose URL as kind local', () => {
    const env: Record<string, string> = {
      DB_DRIVER: 'pg',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/vod_dev',
    }
    expect(deriveAnswersFromEnv(env).db).toEqual({ kind: 'local' })
  })
})

describe('helpers', () => {
  it('derives driver and URL per runtime', () => {
    expect(dbDriverFor('workers')).toBe('neon-http')
    expect(dbDriverFor('node')).toBe('pg')
    expect(databaseUrlFor('node', { kind: 'local' })).toBe(
      'postgresql://postgres:postgres@localhost:5433/vod_dev',
    )
    expect(databaseUrlFor('node', { kind: 'existing', url: ' postgresql://x/y ' })).toBe(
      'postgresql://x/y',
    )
  })
})

describe('the transcoder provider', () => {
  it('keeps the provider flags in the canonical key set', () => {
    // Not cosmetic: this set decides which pre-existing keys a --force run may
    // rewrite. Out of it, the old value was preserved as an "unknown" key and —
    // because env parsing takes the last occurrence — silently won over the new
    // one. `wrangler secret bulk` reads the same list.
    for (const key of ['TRANSCODE_PROVIDER', 'SELF_HOSTED_ENABLED', 'UPLOADS_ENABLED']) {
      expect(SERVER_KEY_ORDER).toContain(key)
    }
  })

  it('serialises an explicit false so the rollback survives a regeneration', () => {
    expect(selfHostedEnabledValue(workersAnswers({ selfHostedEnabled: false }))).toBe('false')
    expect(selfHostedEnabledValue(workersAnswers({ selfHostedEnabled: true }))).toBe('true')
    // Unset stays blank: blank means "follow the provider".
    expect(selfHostedEnabledValue(workersAnswers())).toBe('')
  })

  it('writes the provider and upload flags into both configurations', () => {
    const local = workersAnswers({
      runtime: 'node',
      db: { kind: 'local' },
      transcodeProvider: 'self-hosted',
      uploadsEnabled: false,
      rawBucket: 'unused-raw',
    })
    for (const entries of [buildDevConfig(local, SECRETS), buildDeployConfig(local, SECRETS)]) {
      const map = new Map(entries)
      expect(map.get('TRANSCODE_PROVIDER')).toBe('self-hosted')
      expect(map.get('UPLOADS_ENABLED')).toBe('false')
      // A raw bucket nobody writes to must not be named: the API treats a
      // present name as a bucket the operator expects to exist.
      expect(map.get('RAW_BUCKET_NAME')).toBe('')
    }
  })

  it('refuses Modal with uploads off, because Modal ingests from the raw bucket', () => {
    const problems = validateChoices({
      runtime: 'workers',
      dbKind: 'neon',
      transcodeProvider: 'modal',
      uploadsEnabled: false,
      queueKind: 'direct',
      rateLimitKind: 'memory',
    })
    expect(problems.some((p) => p.includes('requires uploads'))).toBe(true)
  })

  it('does not need a raw bucket for a local-only installation', () => {
    const local = workersAnswers({
      runtime: 'node',
      db: { kind: 'local' },
      transcodeProvider: 'self-hosted',
      uploadsEnabled: false,
      rawBucket: '',
    })
    expect(needsRawBucket(local)).toBe(false)
    expect(validateCredentials(local).some((p) => p.includes('rawBucket'))).toBe(false)
  })
})

describe('validation stages', () => {
  it('checks compatibility before any credential exists', () => {
    // The choice stage sees kinds, not values: it must accept a shape whose URLs
    // have not been collected yet, so it can run before anything is installed.
    expect(
      validateChoices({
        target: 'dev',
        runtime: 'workers',
        dbKind: 'neon',
        transcodeProvider: 'modal',
        uploadsEnabled: true,
        queueKind: 'direct',
        rateLimitKind: 'memory',
      }),
    ).toEqual([])
  })

  it('reports missing values only in the credential stage', () => {
    const answers = workersAnswers({ db: { kind: 'neon' }, accountId: '' })
    expect(
      validateChoices({
        runtime: 'workers',
        dbKind: 'neon',
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
    const local = workersAnswers({
      target: 'dev',
      runtime: 'node',
      db: { kind: 'local' },
      transcodeProvider: 'self-hosted',
      uploadsEnabled: false,
      selfHostedEnabled: false,
    })
    const entries = new Map(buildDevConfig(local, SECRETS))
    const derived = deriveAnswersFromConfig('dev', Object.fromEntries(entries))
    expect(derived.transcodeProvider).toBe('self-hosted')
    expect(derived.uploadsEnabled).toBe(false)
    // An explicit false is preserved, not collapsed into "follow the provider".
    expect(derived.selfHostedEnabled).toBe(false)
  })

  it('round-trips the deploy target through the .env builder', () => {
    const deploy = workersAnswers({
      target: 'deploy',
      runtime: 'node',
      db: { kind: 'existing', url: 'postgresql://db.example.com:5432/clipmux' },
      transcodeProvider: 'modal',
      queue: { kind: 'qstash', token: 'qst_7' },
    })
    const entries = new Map(buildDeployConfig(deploy, SECRETS))
    const derived = deriveAnswersFromConfig('deploy', Object.fromEntries(entries))
    expect(derived.target).toBe('deploy')
    expect(derived.runtime).toBe('node')
    expect(derived.db).toEqual({
      kind: 'existing',
      url: 'postgresql://db.example.com:5432/clipmux',
    })
    expect(derived.queue).toEqual({ kind: 'qstash', token: 'qst_7' })
  })

  it('reads a file written before the provider flags existed as modal + uploads on', () => {
    const legacy: Record<string, string> = {
      DB_DRIVER: 'neon-http',
      DATABASE_URL: 'postgresql://user:pass@ep-x.aws.neon.tech/vod',
      ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      RAW_BUCKET_NAME: 'clipmux-raw',
    }
    const derived = deriveAnswersFromConfig('dev', legacy)
    expect(derived.transcodeProvider).toBe('modal')
    expect(derived.uploadsEnabled).toBe(true)
    expect(derived.selfHostedEnabled).toBeUndefined()
  })
})
