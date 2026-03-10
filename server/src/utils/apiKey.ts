import { createHash, randomBytes } from 'node:crypto'

const API_KEY_SECRET_PREFIX = 'sk_live_'

export function generateApiKey(): { id: string; key: string } {
  const id = `sk_${randomBytes(8).toString('hex')}`
  const key = `${API_KEY_SECRET_PREFIX}${randomBytes(24).toString('hex')}`

  return { id, key }
}

export function hashApiKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function getApiKeyLast4(value: string): string {
  return value.slice(-4)
}

export function getApiKeyPreview(last4: string): string {
  return `${API_KEY_SECRET_PREFIX}...${last4}`
}
