import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { healthApp } from '../../src/routes/health'

// Minimal env values, none of which are secrets.
const FULL_TEST_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@db.example.com/neondb?sslmode=require',
  BETTER_AUTH_SECRET: 'a-32-character-secret-string-1234567890',
  JWT_SECRET: 'another-32-character-secret-string-9876543',
  ACCOUNT_ID: 'cf-account-123',
  R2_ACCESS_KEY_ID: 'r2-access-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret-key',
  RAW_BUCKET_NAME: 'raw-uploads',
  TRANSCODED_BUCKET_NAME: 'transcoded-media',
  MODAL_WEBHOOK_URL: 'https://user--app.modal.run/transcode',
  MODAL_WEBHOOK_SECRET: 'modal-secret',
  DELIVERY_URL: 'https://media.example.com',
  CLOUDFLARE_ANALYTICS_TOKEN: 'analytics-token',
}

const SECRET_MARKERS = [
  FULL_TEST_ENV.R2_SECRET_ACCESS_KEY!,
  FULL_TEST_ENV.JWT_SECRET!,
  FULL_TEST_ENV.BETTER_AUTH_SECRET!,
]

describe('GET /health/config', () => {
  const app = new Hono().route('/health', healthApp)

  it('reports not ready with per-capability checks when unconfigured', async () => {
    const previous = { ...process.env }
    Object.keys(FULL_TEST_ENV).forEach((k) => delete process.env[k])

    try {
      const res = await app.request('/health/config')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        service: string
        ready: boolean
        checks: Record<string, boolean>
        problems: string[]
      }
      expect(body.service).toBe('openvod')
      expect(body.ready).toBe(false)
      expect(Object.keys(body.checks).sort()).toEqual(
        ['ai', 'analytics', 'auth', 'database', 'storage', 'transcoder'].sort(),
      )
      expect(Object.values(body.checks).every((v) => v === false)).toBe(true)
      expect(body.problems.length).toBeGreaterThanOrEqual(6)
    } finally {
      process.env = { ...previous }
    }
  })

  it('reports ready when fully configured and never leaks secrets', async () => {
    const previous = { ...process.env }
    process.env = { ...previous, ...FULL_TEST_ENV }

    try {
      const res = await app.request('/health/config')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        ready: boolean
        problems: string[]
      }
      expect(body.ready).toBe(true)
      expect(body.problems).toEqual([])

      const raw = await (await app.request('/health/config')).text()
      for (const marker of SECRET_MARKERS) {
        expect(raw.includes(marker)).toBe(false)
      }
      expect(raw.includes('super_secret')).toBe(false)
    } finally {
      process.env = { ...previous }
    }
  })

  it('serves the plain text health probe', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
