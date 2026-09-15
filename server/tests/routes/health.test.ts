import { describe, expect, it } from 'vitest'
import { healthApp } from '../../src/routes/health'
import { createTestRuntime, fullyConfiguredEnv, withRuntime } from '../helpers/runtime'

// Minimal env values, none of which are secrets.
const FULL_TEST_ENV = fullyConfiguredEnv()

const SECRET_MARKERS = [
  FULL_TEST_ENV.R2_SECRET_ACCESS_KEY!,
  FULL_TEST_ENV.JWT_SECRET!,
  FULL_TEST_ENV.BETTER_AUTH_SECRET!,
]

/**
 * This suite used to drive `process.env` and call `app.request()` with no `env`
 * at all, which locked in the ambient-environment path as the *correct* one.
 * Configuration now arrives through the runtime, so the deployment shape under
 * test is explicit — and a Workers-shaped runtime is expressible.
 */
function appFor(env: Record<string, string | undefined>) {
  return withRuntime(healthApp, createTestRuntime(env), '/health')
}

describe('GET /health/config', () => {
  it('reports not ready with per-capability checks when unconfigured', async () => {
    const app = appFor({})

    const res = await app.request('/health/config')
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      service: string
      ready: boolean
      checks: Record<string, boolean>
      problems: string[]
      deployment: { runtime: string; deliveryRuntime: string }
    }
    expect(body.service).toBe('clipmux')
    expect(body.ready).toBe(false)
    expect(Object.keys(body.checks).sort()).toEqual(
      ['ai', 'analytics', 'auth', 'database', 'delivery', 'rawUploads', 'storage', 'transcoder'].sort(),
    )
    expect(Object.values(body.checks).every((v) => v === false)).toBe(true)
    expect(body.problems.length).toBeGreaterThanOrEqual(6)
    // The deployment shape is part of the contract: it is how an operator sees
    // which runtime and providers are actually in force.
    expect(body.deployment.runtime).toBe('node')
    expect(body.deployment.deliveryRuntime).toBe('cloudflare-worker')
  })

  it('reports ready when fully configured and never leaks secrets', async () => {
    const app = appFor(FULL_TEST_ENV)

    const res = await app.request('/health/config')
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      ready: boolean
      problems: string[]
      deployment: {
        dbTransport: string
        rateLimitStore: string
        transcodeProvider: string
        modalDispatch: string
        analyticsWrite: string
        deliveryUrl: string | null
      }
    }
    expect(body.ready).toBe(true)
    expect(body.problems).toEqual([])
    expect(body.deployment).toMatchObject({
      dbTransport: 'neon-http',
      rateLimitStore: 'memory',
      transcodeProvider: 'modal',
      modalDispatch: 'direct-http',
      analyticsWrite: 'none',
      deliveryUrl: 'https://media.example.com',
    })

    const raw = await (await app.request('/health/config')).text()
    for (const marker of SECRET_MARKERS) {
      expect(raw.includes(marker)).toBe(false)
    }
    expect(raw.includes('super_secret')).toBe(false)
  })

  it('reports the Workers shape, including the analytics sink it has', async () => {
    const app = withRuntime(
      healthApp,
      createTestRuntime(FULL_TEST_ENV, {
        runtime: 'workers',
        analytics: { canWritePlayback: true, writePlayback: () => 0 },
      }),
      '/health',
    )

    const res = await app.request('/health/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      deployment: { runtime: string; analyticsWrite: string }
    }
    expect(body.deployment.runtime).toBe('workers')
    expect(body.deployment.analyticsWrite).toBe('workers-analytics-engine')
  })

  it('reports a fatal problem for a TCP Postgres on Workers', async () => {
    const app = withRuntime(
      healthApp,
      createTestRuntime({ ...FULL_TEST_ENV, DB_DRIVER: 'pg' }, { runtime: 'workers' }),
      '/health',
    )

    const res = await app.request('/health/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ready: boolean; problems: string[] }
    expect(body.ready).toBe(false)
    expect(body.problems.join('\n')).toMatch(/DB_DRIVER=pg cannot work on Cloudflare Workers/)
  })

  it('serves the plain text health probe', async () => {
    const app = appFor(FULL_TEST_ENV)
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
