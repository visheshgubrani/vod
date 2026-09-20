import { describe, expect, it } from 'vitest'
import { browserUploadCorsOrigins, wranglerProcessEnv } from '../src/cloudflare'

describe('browserUploadCorsOrigins', () => {
  it('keeps local Next ports even when the dashboard origin is localhost:3000', () => {
    expect(browserUploadCorsOrigins('http://localhost:3000')).toEqual([
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
    ])
  })

  it('puts a custom dashboard origin first, then local upload origins', () => {
    expect(browserUploadCorsOrigins('https://dev.clipmux.com')).toEqual([
      'https://dev.clipmux.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
    ])
  })

  it('falls back to local upload origins when the dashboard origin is blank', () => {
    expect(browserUploadCorsOrigins('  ')).toEqual([
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
    ])
  })
})

describe('wranglerProcessEnv', () => {
  it('sets CLOUDFLARE_ACCOUNT_ID without dropping PATH', () => {
    const env = wranglerProcessEnv('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('leaves the process environment alone when no account is selected', () => {
    expect(wranglerProcessEnv(undefined).CLOUDFLARE_ACCOUNT_ID).toBe(process.env.CLOUDFLARE_ACCOUNT_ID)
  })
})
