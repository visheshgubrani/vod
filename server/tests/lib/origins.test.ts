import { describe, expect, it } from 'vitest'
import { matchOrigin } from '../../src/lib/config'

describe('matchOrigin', () => {
  const localDev = ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000']

  it('rejects empty or missing origins', () => {
    expect(matchOrigin(undefined, ['https://app.example.com'])).toBe(false)
    expect(matchOrigin(null, ['https://app.example.com'])).toBe(false)
    expect(matchOrigin('', ['https://app.example.com'])).toBe(false)
    expect(matchOrigin('not-a-url', ['https://app.example.com'])).toBe(false)
  })

  it('matches exact origins', () => {
    expect(matchOrigin('https://app.example.com', ['https://app.example.com'])).toBe(true)
    expect(matchOrigin('https://app.example.com', [])).toBe(false)
    expect(matchOrigin('http://localhost:3000', localDev)).toBe(true)
  })

  it('matches subdomains of a *.wildcard pattern but not the apex', () => {
    const patterns = ['*.vercel.app']
    expect(matchOrigin('https://openvod-preview-123.vercel.app', patterns)).toBe(true)
    expect(matchOrigin('https://vercel.app', patterns)).toBe(false)
  })

  it('does not match lookalike domains against wildcard patterns', () => {
    expect(matchOrigin('https://evilvercel.app', ['*.vercel.app'])).toBe(false)
    expect(matchOrigin('https://notvercel.app.evil.com', ['*.vercel.app'])).toBe(false)
  })

  it('treats "*" as allow-all', () => {
    expect(matchOrigin('https://anything.example.org', ['*'])).toBe(true)
  })

  it('matches hostname-only patterns against full origins', () => {
    expect(matchOrigin('https://app.example.com', ['app.example.com'])).toBe(true)
    expect(matchOrigin('https://sub.vercel.app', ['*.vercel.app'])).toBe(true)
  })

  it('ignores scheme/port case differences for wildcard subdomain checks', () => {
    expect(matchOrigin('HTTPS://SUB.VERCEL.APP', ['*.vercel.app'])).toBe(true)
    expect(matchOrigin('http://preview.vercel.app:3000', ['*.vercel.app'])).toBe(true)
  })

  it('matches multiple patterns when any one applies', () => {
    const patterns = ['https://exact.example.com', '*.vercel.app']
    expect(matchOrigin('https://other.vercel.app', patterns)).toBe(true)
    expect(matchOrigin('https://exact.example.com', patterns)).toBe(true)
    expect(matchOrigin('https://exact.example.org', patterns)).toBe(false)
  })
})
