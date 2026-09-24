import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deliveryVarsPath,
  deployEnvPath,
  existingTargets,
  readTargetConfig,
  serverVarsPath,
  upsertTargetConfig,
  writeTargetConfig,
} from '../src/envio'
import { buildDeliveryEntries, buildDevConfig, buildDeployConfig } from '../src/mapping'
import { newSecretSet, preservedSecretKeys, secretSetFor } from '../src/secret'
import { parseEntriesAsMap } from '../src/envfile'
import type { SecretSet, WizardAnswers } from '../src/types'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clipmux-envio-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const SECRETS: SecretSet = {
  betterAuthSecret: 'a'.repeat(64),
  jwtSecret: 'b'.repeat(64),
  internalSweepSecret: 'c'.repeat(64),
    transcodeIngestSecret: 'd'.repeat(64),
  localTranscoderSecret: 'g'.repeat(64),
  analyticsIngestSecret: 'f'.repeat(64),
  postgresPassword: 'e'.repeat(48),
}

function answers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    target: 'dev',
    db: { kind: 'existing', url: 'postgresql://user:pass@db.example.com/vod' },
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

function writeDev(config: WizardAnswers, secrets: SecretSet = SECRETS, force = true): string[] {
  return writeTargetConfig(
    root,
    'dev',
    { primary: buildDevConfig(config, secrets), delivery: buildDeliveryEntries(secrets) },
    force,
  )
}

describe('writeTargetConfig', () => {
  it('writes the dev pair with mode 0600', () => {
    const paths = writeDev(answers())
    expect(paths).toEqual([serverVarsPath(root), deliveryVarsPath(root)])
    for (const path of paths) {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(readTargetConfig(root, 'dev')?.['DATABASE_URL']).toContain('db.example.com')
  })

  it('writes only the root .env for the deploy target', () => {
    writeTargetConfig(
      root,
      'deploy',
      { primary: buildDeployConfig(answers({ target: 'deploy' }), SECRETS) },
      true,
    )
    expect(existingTargets(root)).toEqual(['deploy'])
    expect(readTargetConfig(root, 'deploy')?.['POSTGRES_PASSWORD']).toBe(SECRETS.postgresPassword)
    expect(existingTargets(root)).not.toContain('dev')
  })

  it('refuses to clobber without force', () => {
    writeDev(answers())
    expect(() => writeDev(answers(), SECRETS, false)).toThrow(/already exists/)
  })

  it('lets a reconfiguration change the provider — the new value is the one read back', () => {
    // The regression: the provider keys were outside the canonical key set, so
    // a --force rewrite emitted the new value and then preserved the old one as
    // an unknown key. Parsing takes the last occurrence, so the *old* provider
    // won and `--deploy` provisioned Modal for a local install.
    writeDev(answers({ transcodeProvider: 'modal' }))
    writeDev(
      answers({
        transcodeProvider: 'local',
        uploadsEnabled: false,
        db: { kind: 'local' },
      }),
    )
    const text = readFileSync(serverVarsPath(root), 'utf8')
    expect(text.match(/^TRANSCODE_PROVIDER=/gm)).toHaveLength(1)
    expect(readTargetConfig(root, 'dev')?.['TRANSCODE_PROVIDER']).toBe('local')
    expect(readTargetConfig(root, 'dev')?.['UPLOADS_ENABLED']).toBe('false')
  })

  it('preserves keys the wizard does not manage', () => {
    writeDev(answers())
    const path = serverVarsPath(root)
    writeFileSync(path, `${readFileSync(path, 'utf8')}GOOGLE_CLIENT_ID=abc123\n`)
    writeDev(answers({ frontendUrl: 'https://app.example.com' }))
    const map = readTargetConfig(root, 'dev') ?? {}
    expect(map['GOOGLE_CLIENT_ID']).toBe('abc123')
    expect(map['FRONTEND_URL']).toBe('https://app.example.com')
  })
})

describe('upsertTargetConfig', () => {
  it('updates the deploy .env in place without touching unrelated lines', () => {
    writeTargetConfig(
      root,
      'deploy',
      { primary: buildDeployConfig(answers({ target: 'deploy' }), SECRETS) },
      true,
    )
    upsertTargetConfig(root, 'deploy', [
      ['DELIVERY_URL', 'https://delivery.example.workers.dev'],
      ['MODAL_WEBHOOK_URL', 'https://acme--clipmux-transcode.modal.run'],
    ])
    const map = readTargetConfig(root, 'deploy') ?? {}
    expect(map['DELIVERY_URL']).toBe('https://delivery.example.workers.dev')
    expect(map['MODAL_WEBHOOK_URL']).toBe('https://acme--clipmux-transcode.modal.run')
    expect(map['POSTGRES_PASSWORD']).toBe(SECRETS.postgresPassword)
  })

  it('explains which target to configure when the file is absent', () => {
    expect(() => upsertTargetConfig(root, 'deploy', [['DELIVERY_URL', 'x']])).toThrow(
      /--target deploy/,
    )
  })
})

describe('existingTargets', () => {
  it('reports both configurations when both exist', () => {
    writeDev(answers())
    writeTargetConfig(
      root,
      'deploy',
      { primary: buildDeployConfig(answers({ target: 'deploy' }), SECRETS) },
      true,
    )
    expect(existingTargets(root)).toEqual(['dev', 'deploy'])
    expect(existingTargets(root)).toContain('deploy')
  })

  it('reports nothing on a fresh clone', () => {
    expect(existingTargets(root)).toEqual([])
  })

  it('counts a lone delivery/.dev.vars as a dev target', () => {
    mkdirSync(join(root, 'delivery'), { recursive: true })
    writeFileSync(deliveryVarsPath(root), 'JWT_SECRET=x\n')
    expect(existingTargets(root)).toEqual(['dev'])
  })
})

describe('secret preservation', () => {
  it('reuses what the file already holds', () => {
    const existing = parseEntriesAsMap(
      [
        'BETTER_AUTH_SECRET=existing-auth',
        'JWT_SECRET=existing-jwt',
        'POSTGRES_PASSWORD=existing-pg',
        'UNRELATED=x',
      ].join('\n'),
    )
    const secrets = secretSetFor(existing)
    expect(secrets.betterAuthSecret).toBe('existing-auth')
    expect(secrets.jwtSecret).toBe('existing-jwt')
    expect(secrets.postgresPassword).toBe('existing-pg')
    // Missing ones are generated rather than left blank.
    expect(secrets.internalSweepSecret).toHaveLength(64)
    expect(secrets.transcodeIngestSecret).toHaveLength(64)
    expect(preservedSecretKeys(existing).sort()).toEqual([
      'BETTER_AUTH_SECRET',
      'JWT_SECRET',
      'POSTGRES_PASSWORD',
    ])
  })

  it('generates everything on a first write, and on an explicit rotation', () => {
    const fresh = secretSetFor(undefined)
    expect(fresh.jwtSecret).toHaveLength(64)
    const rotated = secretSetFor({ JWT_SECRET: 'old' }, { rotate: true })
    expect(rotated.jwtSecret).not.toBe('old')
    expect(preservedSecretKeys({ JWT_SECRET: 'old' }, { rotate: true })).toEqual([])
  })

  it('never returns the same value twice', () => {
    const secrets = newSecretSet()
    expect(new Set(Object.values(secrets)).size).toBe(Object.values(secrets).length)
  })
})
