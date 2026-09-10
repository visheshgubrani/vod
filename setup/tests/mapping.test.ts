import { describe, expect, it } from 'vitest'
import type { SecretSet, WizardAnswers } from '../src/types'
import {
  buildDeliveryEntries,
  buildServerEntries,
  databaseUrlFor,
  dbDriverFor,
  deriveAnswersFromEnv,
  validateAnswers,
} from '../src/mapping'

const SECRETS: SecretSet = {
  betterAuthSecret: 'a'.repeat(64),
  jwtSecret: 'b'.repeat(64),
  internalSweepSecret: 'c'.repeat(64),
  transcodeIngestSecret: 'd'.repeat(64),
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
    rawBucket: 'openvod-raw',
    transcodedBucket: 'openvod-transcoded',
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

  it('accepts compose + local and compose + existing', () => {
    const local = workersAnswers({
      runtime: 'compose',
      db: { kind: 'local' },
      queue: { kind: 'direct' },
    })
    expect(validateAnswers(local)).toEqual([])

    const existing = workersAnswers({
      runtime: 'compose',
      db: { kind: 'existing', url: 'postgresql://db.example.com:5432/vod' },
    })
    expect(validateAnswers(existing)).toEqual([])
  })

  it('rejects compose + neon (pg driver cannot use neon-http)', () => {
    const answers = workersAnswers({ runtime: 'compose', db: { kind: 'neon' } })
    expect(validateAnswers(answers).some((p) => p.includes('compose'))).toBe(true)
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
    const entries = new Map(buildServerEntries(workersAnswers(), SECRETS))
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

  it('maps compose + local to pg + the host-side compose URL', () => {
    const entries = new Map(
      buildServerEntries(
        workersAnswers({ runtime: 'compose', db: { kind: 'local' } }),
        SECRETS,
      ),
    )
    expect(entries.get('DB_DRIVER')).toBe('pg')
    expect(entries.get('DATABASE_URL')).toBe('postgresql://postgres:postgres@localhost:5433/vod_dev')
  })

  it('maps qstash and upstash choices into their keys', () => {
    const entries = new Map(
      buildServerEntries(
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
    const entries = new Map(buildServerEntries(workersAnswers(), SECRETS))
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
    const entries = new Map(buildServerEntries(original, SECRETS))
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
    expect(dbDriverFor('compose')).toBe('pg')
    expect(databaseUrlFor('compose', { kind: 'local' })).toBe(
      'postgresql://postgres:postgres@localhost:5433/vod_dev',
    )
    expect(databaseUrlFor('compose', { kind: 'existing', url: ' postgresql://x/y ' })).toBe(
      'postgresql://x/y',
    )
  })
})
