import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bareHost,
  callbackHostsFromEnv,
  forceOverwriteModalSecret,
  isLoopbackHost,
  legacySecretsPresent,
  MODAL_CREDS_SECRET,
  MODAL_GROQ_SECRET,
  modalSecretWritePlan,
  openvodCredsFromEnv,
  secretCreateJsonArgs,
  transcodingDeployRequirements,
  transcodingVenvModalBin,
} from '../src/modal'
import { MODAL_MIN_VERSION } from '../src/parsers'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** A complete, valid server/.dev.vars as a parsed map. */
function serverEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    R2_ACCESS_KEY_ID: 'r2-access-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret-key',
    RAW_BUCKET_NAME: 'openvod-raw',
    TRANSCODED_BUCKET_NAME: 'openvod-transcoded',
    TRANSCODE_INGEST_SECRET: 'ingest-from-dev-vars',
    BACKEND_URL: 'https://framing-canning-haphazard.ngrok-free.dev',
    ...overrides,
  }
}

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

  it('pins the same minimum the version gate enforces', () => {
    // The gate refuses a venv whose `modal` is older than MODAL_MIN_VERSION, so
    // the two must agree: a requirements bump that misses the gate would let an
    // unsupported CLI through to a deploy.
    const requirements = readFileSync(transcodingDeployRequirements(repoRoot), 'utf8')
    const pinned = /modal>=(\d+\.\d+\.\d+)/.exec(requirements)
    expect(pinned?.[1]).toBe(MODAL_MIN_VERSION)
  })
})

describe('the secret names the transcoder deploys with', () => {
  it('are the names transcoding/main.py references', () => {
    // A rename that misses main.py deploys a pipeline whose functions cannot
    // hydrate their credentials — caught here rather than at deploy time.
    const mainPy = readFileSync(join(repoRoot, 'transcoding', 'main.py'), 'utf8')
    const referenced = [...mainPy.matchAll(/modal\.Secret\.from_name\(\s*"([a-z0-9-]+)"/g)].map(
      (match) => match[1],
    )
    // ingest endpoint + GPU worker share the creds secret; the worker also needs Groq.
    expect(referenced.filter((name) => name === MODAL_CREDS_SECRET)).toHaveLength(2)
    expect(referenced).toContain(MODAL_GROQ_SECRET)
    expect(referenced).not.toContain('r2-creds')
    expect(referenced).not.toContain('groq-creds')
  })
})

describe('modalSecretWritePlan', () => {
  it('overwrites openvod-creds from the current env even when the secret already exists', () => {
    const existing = [MODAL_CREDS_SECRET, MODAL_GROQ_SECRET]
    const force = forceOverwriteModalSecret(MODAL_CREDS_SECRET)
    expect(force).toBe(true)
    expect(modalSecretWritePlan(existing, MODAL_CREDS_SECRET, force)).toBe('overwrite')
  })

  it('leaves openvod-groq-creds in place when it already exists', () => {
    const force = forceOverwriteModalSecret(MODAL_GROQ_SECRET)
    expect(force).toBe(false)
    expect(modalSecretWritePlan([MODAL_GROQ_SECRET], MODAL_GROQ_SECRET, force)).toBe('skip')
    expect(modalSecretWritePlan([], MODAL_GROQ_SECRET, force)).toBe('create')
  })
})

describe('secretCreateJsonArgs', () => {
  it('passes values through a file so they never reach the process table', () => {
    expect(secretCreateJsonArgs('openvod-creds', '/tmp/x/openvod-creds.json', true)).toEqual([
      'secret',
      'create',
      '--force',
      '--from-json',
      '/tmp/x/openvod-creds.json',
      'openvod-creds',
    ])
    expect(secretCreateJsonArgs('openvod-groq-creds', '/tmp/x/g.json', false)).toEqual([
      'secret',
      'create',
      '--from-json',
      '/tmp/x/g.json',
      'openvod-groq-creds',
    ])
  })
})

describe('legacySecretsPresent', () => {
  it('reports the pre-rename secrets that are still in the workspace', () => {
    expect(legacySecretsPresent(['openvod-creds', 'r2-creds'])).toEqual(['r2-creds'])
    expect(legacySecretsPresent(['openvod-creds', 'openvod-groq-creds'])).toEqual([])
  })
})

describe('bareHost', () => {
  it('drops the scheme, the port and the path, and lowercases', () => {
    expect(bareHost('https://API.Example.com:8787/hooks')).toBe('api.example.com')
    expect(bareHost('http://localhost:8787')).toBe('localhost')
  })

  it('accepts a hostname pasted without a scheme', () => {
    expect(bareHost('api.example.com')).toBe('api.example.com')
    expect(bareHost('api.example.com:8787')).toBe('api.example.com')
  })

  it('returns null for nothing usable', () => {
    expect(bareHost('')).toBeNull()
    expect(bareHost(undefined)).toBeNull()
    expect(bareHost('not a url')).toBeNull()
  })
})

describe('isLoopbackHost', () => {
  it('flags the addresses a Modal worker can never reach', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(true)
    expect(isLoopbackHost('api.example.com')).toBe(false)
    expect(isLoopbackHost(null)).toBe(false)
  })
})

describe('callbackHostsFromEnv', () => {
  it('always allows loopback and adds the BACKEND_URL host the API actually calls back to', () => {
    expect(callbackHostsFromEnv(serverEnv())).toEqual([
      'localhost',
      '127.0.0.1',
      'framing-canning-haphazard.ngrok-free.dev',
    ])
  })

  it('does not duplicate a localhost BACKEND_URL', () => {
    expect(callbackHostsFromEnv(serverEnv({ BACKEND_URL: 'http://localhost:8787' }))).toEqual([
      'localhost',
      '127.0.0.1',
    ])
  })
})

describe('openvodCredsFromEnv', () => {
  it('maps the transcoded bucket to R2_BUCKET_NAME and the raw bucket to ALLOWED_SOURCE_BUCKETS', () => {
    const { values, problems, advisories } = openvodCredsFromEnv(serverEnv())
    expect(problems).toEqual([])
    expect(advisories).toEqual([])
    expect(values).toEqual({
      R2_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      R2_ACCESS_KEY_ID: 'r2-access-key',
      R2_SECRET_ACCESS_KEY: 'r2-secret-key',
      R2_BUCKET_NAME: 'openvod-transcoded',
      TRANSCODE_INGEST_SECRET: 'ingest-from-dev-vars',
      ALLOWED_CALLBACK_HOSTS: 'localhost,127.0.0.1,framing-canning-haphazard.ngrok-free.dev',
      ALLOWED_SOURCE_BUCKETS: 'openvod-raw',
    })
  })

  it('reads the buckets from the env file, so a hand-edited name cannot drift', () => {
    // The old code took the transcoded bucket from the wizard's in-memory
    // answers: editing .dev.vars afterwards left Modal writing to the old bucket.
    const { values } = openvodCredsFromEnv(
      serverEnv({ TRANSCODED_BUCKET_NAME: 'edited-output', RAW_BUCKET_NAME: 'edited-input' }),
    )
    expect(values.R2_BUCKET_NAME).toBe('edited-output')
    expect(values.ALLOWED_SOURCE_BUCKETS).toBe('edited-input')
  })

  it('refuses to build a payload when a required key is missing', () => {
    const { problems } = openvodCredsFromEnv(
      serverEnv({ ACCOUNT_ID: '', TRANSCODE_INGEST_SECRET: '   ', TRANSCODED_BUCKET_NAME: '' }),
    )
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toContain('ACCOUNT_ID')
    expect(problems.join('\n')).toContain('TRANSCODE_INGEST_SECRET')
    expect(problems.join('\n')).toContain('TRANSCODED_BUCKET_NAME')
  })

  it('omits ALLOWED_SOURCE_BUCKETS rather than writing an empty value, and says why', () => {
    const { values, advisories } = openvodCredsFromEnv(serverEnv({ RAW_BUCKET_NAME: '' }))
    expect(values).not.toHaveProperty('ALLOWED_SOURCE_BUCKETS')
    expect(advisories.join('\n')).toContain('ALLOWED_SOURCE_BUCKETS')
  })

  it('warns when BACKEND_URL cannot be reached from Modal', () => {
    const loopback = openvodCredsFromEnv(serverEnv({ BACKEND_URL: 'http://localhost:8787' }))
    expect(loopback.advisories.join('\n')).toContain('loopback')

    const unset = openvodCredsFromEnv(serverEnv({ BACKEND_URL: '' }))
    expect(unset.advisories.join('\n')).toContain('BACKEND_URL is not set')
  })
})
