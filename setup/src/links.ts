/**
 * Where to get each credential, in one place.
 *
 * Every prompt that asks for a key or a token is preceded by the page that
 * creates it. The links are pure data so they can be unit-tested and so no
 * prompt can invent its own URL.
 */

import chalk from 'chalk'
import { analyticsTokenTemplateUrl } from './parsers'

export type LinkKind =
  | 'cloudflare'
  | 'cfAccountId'
  | 'r2ApiTokens'
  | 'cfAnalyticsToken'
  | 'neon'
  | 'modal'
  | 'modalTokens'
  | 'qstash'
  | 'upstash'
  | 'groq'

export interface ProviderLink {
  label: string
  url: string
  /** One line of context — what to click, or what the value must allow. */
  note?: string
}

export function providerLink(kind: LinkKind): ProviderLink {
  switch (kind) {
    case 'cloudflare':
      return {
        label: 'Cloudflare account',
        url: 'https://dash.cloudflare.com/sign-up',
        note: 'free tier is enough to start',
      }
    case 'cfAccountId':
      return {
        label: 'Cloudflare account id',
        url: 'https://dash.cloudflare.com',
        note: 'the 32-hex id is part of the dashboard URL',
      }
    case 'r2ApiTokens':
      return {
        label: 'R2 S3 API token',
        url: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
        note: 'permission: Object Read & Write on both buckets',
      }
    case 'cfAnalyticsToken':
      return {
        label: 'Cloudflare analytics token (optional)',
        url: analyticsTokenTemplateUrl(),
        note: 'Account Analytics · Read — only for the usage dashboard',
      }
    case 'neon':
      return {
        label: 'Neon project',
        url: 'https://console.neon.tech/app/projects',
        note: 'Connection details → the postgresql:// URI',
      }
    case 'modal':
      return {
        label: 'Modal account',
        url: 'https://modal.com/signup',
        note: 'GPU transcoding (FFmpeg / Shaka / Whisper)',
      }
    case 'modalTokens':
      return {
        label: 'Modal tokens',
        url: 'https://modal.com/settings/tokens',
        note: 'only needed if `modal setup` cannot open a browser',
      }
    case 'qstash':
      return {
        label: 'QStash token',
        url: 'https://console.upstash.com/qstash',
        note: 'the token, not the signing key',
      }
    case 'upstash':
      return {
        label: 'Upstash Redis (REST URL + token)',
        url: 'https://console.upstash.com/redis',
        note: 'REST API section of the database page',
      }
    case 'groq':
      return {
        label: 'Groq API key',
        url: 'https://console.groq.com/keys',
        note: 'AI subtitles and chapters',
      }
  }
}

/** Single-line form: `→ Label — https://…`. */
export function linkLine(kind: LinkKind): string {
  const link = providerLink(kind)
  return `${chalk.cyan('→')} ${link.label} ${chalk.dim('—')} ${chalk.cyan(link.url)}`
}

/** Multi-line form for a clack note body (one block per link). */
export function linksNote(kinds: readonly LinkKind[]): string {
  return kinds
    .map((kind) => {
      const link = providerLink(kind)
      const lines = [linkLine(kind)]
      if (link.note) lines.push(`  ${chalk.dim(link.note)}`)
      return lines.join('\n')
    })
    .join('\n\n')
}
