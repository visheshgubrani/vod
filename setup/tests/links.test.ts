import { describe, expect, it } from 'vitest'
import { linkLine, linksNote, providerLink, type LinkKind } from '../src/links'

const ALL_KINDS: LinkKind[] = [
  'cloudflare',
  'cfAccountId',
  'r2ApiTokens',
  'cfAnalyticsToken',
  'neon',
  'modal',
  'modalTokens',
  'qstash',
  'upstash',
  'groq',
]

describe('providerLink', () => {
  it('points every kind at an https page on the provider we expect', () => {
    const hosts: Record<LinkKind, string> = {
      cloudflare: 'dash.cloudflare.com',
      cfAccountId: 'dash.cloudflare.com',
      r2ApiTokens: 'dash.cloudflare.com',
      cfAnalyticsToken: 'dash.cloudflare.com',
      neon: 'console.neon.tech',
      modal: 'modal.com',
      modalTokens: 'modal.com',
      qstash: 'console.upstash.com',
      upstash: 'console.upstash.com',
      groq: 'console.groq.com',
    }
    for (const kind of ALL_KINDS) {
      const link = providerLink(kind)
      expect(link.url.startsWith('https://'), `${kind} must be https`).toBe(true)
      expect(new URL(link.url).hostname, `${kind} host`).toBe(hosts[kind])
      expect(link.label.trim()).not.toBe('')
    }
  })

  it('takes the Cloudflare analytics template from the one place that defines it', () => {
    const url = providerLink('cfAnalyticsToken').url
    expect(url).toContain('permissionGroupKeys')
    expect(url).toContain('account_analytics')
  })
})

describe('linkLine', () => {
  it('carries the label and the URL', () => {
    const line = linkLine('r2ApiTokens')
    expect(line).toContain('R2 S3 API token')
    expect(line).toContain('https://dash.cloudflare.com/?to=/:account/r2/api-tokens')
  })
})

describe('linksNote', () => {
  it('includes one block per link, in the order asked for', () => {
    const text = linksNote(['neon', 'groq'])
    expect(text.indexOf('console.neon.tech')).toBeLessThan(text.indexOf('console.groq.com'))
    expect(text).toContain('https://console.neon.tech/app/projects')
    expect(text).toContain('https://console.groq.com/keys')
  })

  it('is empty for no links — a missing provider must not invent one', () => {
    expect(linksNote([])).toBe('')
  })
})
