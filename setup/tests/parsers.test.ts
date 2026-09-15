import { describe, expect, it } from 'vitest'
import {
  analyticsTokenTemplateUrl,
  modalAuthState,
  MODAL_MIN_VERSION,
  parseAccountId,
  parseModalClientVersion,
  parseModalImageId,
  parseModalSecretNames,
  parseModalUrl,
  parseModalWorkspace,
  parseWorkersUrl,
  r2BucketAlreadyExists,
  versionAtLeast,
} from '../src/parsers'

describe('analyticsTokenTemplateUrl', () => {
  it('opens Cloudflare token creation with Account Analytics Read selected', () => {
    expect(analyticsTokenTemplateUrl()).toBe(
      'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=ClipMux%20Analytics',
    )
  })
})

describe('parseAccountId', () => {
  it('finds the first 32-hex id in whoami output', () => {
    const text = `
You are logged in as user@example.com.
Associated with the following account:
  Account Name: Example (example@example.com)
  Account ID: a1b2c3d4e5f60718293a4b5c6d7e8f90
  Roles: Administrator
`
    expect(parseAccountId(text)).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
  })

  it('returns null when no id is present', () => {
    expect(parseAccountId('not authenticated')).toBeNull()
  })
})

describe('parseWorkersUrl', () => {
  it('returns the last workers.dev URL without trailing slash', () => {
    const text = `
Total Upload: 0 KiB / 0 KiB
Uploaded vod-api (1.33 sec)
Current Version ID: abc123
https://vod-api.some-subdomain.workers.dev/
`
    expect(parseWorkersUrl(text)).toBe('https://vod-api.some-subdomain.workers.dev')
  })

  it('returns null when no URL was printed', () => {
    expect(parseWorkersUrl('Uploaded vod-api')).toBeNull()
  })
})

describe('parseModalUrl', () => {
  it('prefers the transcode endpoint and strips punctuation', () => {
    const text = `
✓ Created objects.
├─ 🔨 Created modal.Image.
App deployed! 🎉
View app: https://ws--vod-production-pipeline.modal.run
View function: https://ws--vod-production-pipeline-transcode-video.modal.run
`
    expect(parseModalUrl(text)).toBe(
      'https://ws--vod-production-pipeline-transcode-video.modal.run',
    )
  })

  it('falls back to the first URL and trims trailing dots/commas', () => {
    expect(parseModalUrl('Deployed at https://ws--app.modal.run,')).toBe(
      'https://ws--app.modal.run',
    )
    expect(parseModalUrl('nothing here')).toBeNull()
  })
})

describe('parseModalImageId', () => {
  it('extracts the image id from a failed image-build error', () => {
    const text = `
Image build for im-6HTht0cndtn9TUeynzZNjs failed. See build logs for more details.
`
    expect(parseModalImageId(text)).toBe('im-6HTht0cndtn9TUeynzZNjs')
  })

  it('returns null when no image id is present', () => {
    expect(parseModalImageId('modal deploy failed')).toBeNull()
  })
})

describe('modalAuthState', () => {
  it('is authenticated when modal token info exits 0', () => {
    expect(modalAuthState({ code: 0, output: 'Token: ak-…\nWorkspace: acme (ac-1)\n' })).toBe(
      'authenticated',
    )
  })

  it('is NOT authenticated when token info fails, even though profile current succeeds with "default"', () => {
    // The regression this whole function exists for. `modal profile current`
    // prints the default profile name and exits 0 with no token at all, and
    // treating that as a login made the deploy skip `modal setup` and then die
    // inside `modal secret create` with "Token missing".
    const realWorldOutput =
      '│ Token missing. Could not authenticate client. If you have token credentials, │\n' +
      '│ see modal.com/docs/sdk/py/latest/config for setup help. If you are a new     │\n' +
      '│ user, register an account at modal.com, then run `modal token new`.          │'
    expect(modalAuthState({ code: 1, output: realWorldOutput })).toBe('unauthenticated')
  })

  it('treats a rejected or revoked token as unauthenticated', () => {
    expect(modalAuthState({ code: 1, output: 'Error: Unauthorized' })).toBe('unauthenticated')
    expect(modalAuthState({ code: 1, output: 'Invalid token' })).toBe('unauthenticated')
  })

  it('is unverified — never authenticated — when the probe times out or cannot run', () => {
    expect(modalAuthState({ code: null, output: '', timedOut: true })).toBe('unverified')
    expect(modalAuthState({ code: null, output: 'spawn modal ENOENT' })).toBe('unverified')
  })

  it('is unverified for an unrecognised failure, so the caller asks instead of assuming', () => {
    // An older CLI without `token info` exits non-zero with a usage error; that
    // is not evidence of a login, and it is not evidence of a missing token.
    expect(modalAuthState({ code: 2, output: "No such command 'token info'." })).toBe('unverified')
  })
})

describe('parseModalWorkspace', () => {
  it('reads the workspace name out of modal token info', () => {
    const output = [
      'Token: ak-EXAMPLEONLY',
      'Workspace: vkiez384 (ac-LrYRZIkNkTyXAArq4m1lk6)',
      'User: vkiez384 (us-oMjGAztXqSQXmA1yyTnC1p)',
      'Created at: 2026-09-13 16:57:06 IST',
    ].join('\n')
    expect(parseModalWorkspace(output)).toBe('vkiez384')
  })

  it('returns null when there is no workspace line', () => {
    expect(parseModalWorkspace('Token missing.')).toBeNull()
    expect(parseModalWorkspace('Workspace:    ')).toBeNull()
  })
})

describe('modal CLI version gate', () => {
  it('parses the version modal --version prints', () => {
    expect(parseModalClientVersion('modal client version: 1.5.5')).toBe('1.5.5')
    expect(parseModalClientVersion('nonsense')).toBeNull()
  })

  it('compares dotted versions numerically, not lexically', () => {
    expect(versionAtLeast('1.5.5', MODAL_MIN_VERSION)).toBe(true)
    expect(versionAtLeast('1.5.0', MODAL_MIN_VERSION)).toBe(true)
    expect(versionAtLeast('1.10.0', MODAL_MIN_VERSION)).toBe(true)
    expect(versionAtLeast('1.9.0', MODAL_MIN_VERSION)).toBe(true)
    expect(versionAtLeast('0.73.1', MODAL_MIN_VERSION)).toBe(false)
    expect(versionAtLeast('1.4.9', MODAL_MIN_VERSION)).toBe(false)
    expect(versionAtLeast(null, MODAL_MIN_VERSION)).toBe(false)
  })
})

describe('parseModalSecretNames', () => {
  it('reads labels from a JSON secret list', () => {
    const json = `[
      {"label": "r2-creds", "created_at": "2024-06-01T12:00:00+00:00"},
      {"label": "groq-creds", "created_at": "2024-06-01T12:01:00+00:00"}
    ]`
    expect(parseModalSecretNames(json)).toEqual(['r2-creds', 'groq-creds'])
  })

  it('returns an empty list when no secrets are published', () => {
    expect(parseModalSecretNames('[]')).toEqual([])
  })

  it('reads the name column from a Unicode table when JSON is unavailable', () => {
    const table = `
┏━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┓
┃ Name       ┃ Created at            ┃
┡━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━┩
│ r2-creds   │ 2024-06-01 12:00 UTC  │
│ groq-creds │ 2024-06-01 12:01 UTC  │
└────────────┴──────────────────────┘
`
    expect(parseModalSecretNames(table)).toEqual(['r2-creds', 'groq-creds'])
  })
})

describe('r2BucketAlreadyExists', () => {
  it('treats wrangler r2 bucket info exit 0 as an existing bucket', () => {
    expect(
      r2BucketAlreadyExists(0, `{
  "name": "clipmux-raw",
  "created": "2025-06-07T15:55:22.222Z"
}`),
    ).toBe(true)
  })

  it('does not treat a missing-bucket error as existing', () => {
    expect(
      r2BucketAlreadyExists(
        1,
        'The specified bucket does not exist. [code: 10006]',
      ),
    ).toBe(false)
  })
})
