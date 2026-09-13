import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WizardError } from '../src/errors'
import {
  forceOverwriteModalSecret,
  modalSecretWritePlan,
  rawBucketFromServerEnv,
  r2CredsValues,
  requireTranscodeIngestSecret,
  secretCreateArgs,
  transcodingDeployRequirements,
  transcodingVenvModalBin,
} from '../src/modal'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

describe('transcodingVenvModalBin', () => {
  it('points at transcoding/.venv, not a global uv/pipx modal', () => {
    expect(transcodingVenvModalBin('/repo')).toBe('/repo/transcoding/.venv/bin/modal')
  })
})

describe('transcoding/requirements-deploy.txt', () => {
  it('lists local hydrate deps so modal deploy can import main.py', () => {
    const packages = readFileSync(transcodingDeployRequirements(repoRoot), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
    expect(packages).toEqual(['boto3', 'requests', 'fastapi', 'modal>=1.5.0'])
  })
})

describe('modalSecretWritePlan', () => {
  it('overwrites r2-creds from the current ingest secret even when the Modal secret already exists', () => {
    const existing = ['r2-creds', 'groq-creds']
    const force = forceOverwriteModalSecret('r2-creds')
    expect(modalSecretWritePlan(existing, 'r2-creds', force)).toBe('overwrite')
    expect(
      secretCreateArgs('r2-creds', { TRANSCODE_INGEST_SECRET: 'ingest-from-dev-vars' }, true),
    ).toEqual([
      'secret',
      'create',
      '--force',
      'r2-creds',
      'TRANSCODE_INGEST_SECRET=ingest-from-dev-vars',
    ])
  })

  it('leaves groq-creds in place when it already exists', () => {
    expect(
      modalSecretWritePlan(['groq-creds'], 'groq-creds', forceOverwriteModalSecret('groq-creds')),
    ).toBe('skip')
  })
})

describe('requireTranscodeIngestSecret', () => {
  it('refuses to upload an empty ingest secret', () => {
    expect(() => requireTranscodeIngestSecret({})).toThrow(WizardError)
    expect(() => requireTranscodeIngestSecret({ TRANSCODE_INGEST_SECRET: '' })).toThrow(
      /TRANSCODE_INGEST_SECRET/,
    )
    expect(() => requireTranscodeIngestSecret({ TRANSCODE_INGEST_SECRET: '   ' })).toThrow(
      /TRANSCODE_INGEST_SECRET/,
    )
  })

  it('returns the ingest secret from server env', () => {
    expect(
      requireTranscodeIngestSecret({ TRANSCODE_INGEST_SECRET: 'ingest-from-dev-vars' }),
    ).toBe('ingest-from-dev-vars')
  })
})

describe('rawBucketFromServerEnv', () => {
  it('prefers RAW_BUCKET_NAME from server/.dev.vars over a stale wizard answer', () => {
    expect(
      rawBucketFromServerEnv({ RAW_BUCKET_NAME: 'openvod-raw' }, 'wizard-stale'),
    ).toBe('openvod-raw')
  })

  it('falls back to the wizard answer when the env key is missing', () => {
    expect(rawBucketFromServerEnv({}, 'openvod-raw')).toBe('openvod-raw')
  })
})

describe('r2CredsValues', () => {
  it('puts the raw bucket onto ALLOWED_SOURCE_BUCKETS, not the transcoded bucket', () => {
    const secret = r2CredsValues({
      accountId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      transcodedBucket: 'openvod-transcoded',
      rawBucket: 'openvod-raw',
      ingestSecret: 'ingest-from-dev-vars',
      callbackHosts: 'localhost',
    })
    expect(secret.ALLOWED_SOURCE_BUCKETS).toBe('openvod-raw')
    expect(secret.R2_BUCKET_NAME).toBe('openvod-transcoded')
  })
})
