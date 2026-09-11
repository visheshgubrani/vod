import { describe, expect, it } from 'vitest'
import {
  analyticsTokenTemplateUrl,
  isModalCliAuthed,
  parseAccountId,
  parseModalImageId,
  parseModalProfileName,
  parseModalSecretNames,
  parseModalUrl,
  parseWorkersUrl,
  r2BucketAlreadyExists,
} from '../src/parsers'

describe('analyticsTokenTemplateUrl', () => {
  it('opens Cloudflare token creation with Account Analytics Read selected', () => {
    expect(analyticsTokenTemplateUrl()).toBe(
      'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=OpenVOD%20Analytics',
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

describe('isModalCliAuthed', () => {
  it('treats modal token info exit 0 as authenticated', () => {
    expect(isModalCliAuthed({ tokenInfo: { code: 0 } })).toBe(true)
  })

  it('is not authenticated when token info fails and profile current is empty', () => {
    expect(
      isModalCliAuthed({
        tokenInfo: { code: 1 },
        profileCurrent: { code: 1, stdout: '' },
      }),
    ).toBe(false)
  })

  it('falls back to a non-empty profile current when token info is missing', () => {
    expect(
      isModalCliAuthed({
        tokenInfo: { code: 2 },
        profileCurrent: { code: 0, stdout: 'vkiez384\n' },
      }),
    ).toBe(true)
  })
})

describe('parseModalProfileName', () => {
  it('returns the first token from profile current stdout', () => {
    expect(parseModalProfileName('vkiez384\n')).toBe('vkiez384')
  })

  it('returns null when stdout is blank', () => {
    expect(parseModalProfileName('  \n')).toBeNull()
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
  "name": "openvod-raw",
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
