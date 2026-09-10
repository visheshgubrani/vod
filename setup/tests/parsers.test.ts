import { describe, expect, it } from 'vitest'
import { parseAccountId, parseModalUrl, parseWorkersUrl } from '../src/parsers'

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
