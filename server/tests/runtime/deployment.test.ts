import { describe, expect, it } from 'vitest'
import { fatalProblems, resolveDeployment } from '../../src/runtime/deployment'

/**
 * `resolveDeployment` is the single place every choosable axis is decided. These
 * tests pin the answers, because the previous arrangement decided them in
 * several places at once (`app.ts` at module scope, routes per request, the Node
 * entry from `process.env`) and the copies disagreed.
 */

const MODAL_INSTALL = {
  DATABASE_URL: 'postgresql://user:pass@db.example.com/neondb',
  BETTER_AUTH_SECRET: 'a-32-character-secret-string-1234567890',
  JWT_SECRET: 'another-32-character-secret-string-9876543',
  ACCOUNT_ID: 'cf-account-123',
  R2_ACCESS_KEY_ID: 'r2-access-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret-key',
  RAW_BUCKET_NAME: 'raw-uploads',
  TRANSCODED_BUCKET_NAME: 'transcoded-media',
  MODAL_WEBHOOK_URL: 'https://user--app.modal.run/transcode',
  TRANSCODE_INGEST_SECRET: 'ingest-secret',
  DELIVERY_URL: 'https://media.example.com',
}

describe('resolveDeployment', () => {
  it('never throws, whatever it is handed', () => {
    expect(() => resolveDeployment({}, 'node')).not.toThrow()
    expect(() => resolveDeployment({}, 'workers')).not.toThrow()
    expect(() => resolveDeployment({ DB_DRIVER: 'nonsense' }, 'workers')).not.toThrow()
    expect(() => resolveDeployment({ REDIS_URL: 'x' }, 'workers')).not.toThrow()
  })

  it('resolves the Node shape from DB_DRIVER and the caller-provided runtime', () => {
    const { shape } = resolveDeployment(
      { ...MODAL_INSTALL, DB_DRIVER: 'pg', QSTASH_TOKEN: 'qs' },
      'node',
    )

    expect(shape).toMatchObject({
      runtime: 'node',
      dbTransport: 'postgres-js',
      rateLimitStore: 'memory',
      transcodeProvider: 'modal',
      selfHostedEnabled: false,
      modalDispatch: 'qstash',
      analyticsWrite: 'none',
      deliveryRuntime: 'cloudflare-worker',
      deliveryUrl: 'https://media.example.com',
    })
  })

  it('defaults to the Neon HTTP transport, and to direct HTTP dispatch', () => {
    const { shape } = resolveDeployment(MODAL_INSTALL, 'workers')
    expect(shape.dbTransport).toBe('neon-http')
    expect(shape.modalDispatch).toBe('direct-http')
  })

  it('reports the Workers analytics sink only when the binding is present', () => {
    // The binding is an object, not a string, so the root has to say so.
    expect(resolveDeployment(MODAL_INSTALL, 'workers').shape.analyticsWrite).toBe('none')
    expect(
      resolveDeployment(MODAL_INSTALL, 'workers', { hasPlaybackAnalyticsBinding: true }).shape
        .analyticsWrite,
    ).toBe('workers-analytics-engine')
    // Node has no binding to have.
    expect(
      resolveDeployment(MODAL_INSTALL, 'node', { hasPlaybackAnalyticsBinding: true }).shape
        .analyticsWrite,
    ).toBe('none')
  })

  it('reports the self-hosted provider and its enablement', () => {
    const { shape } = resolveDeployment(
      { ...MODAL_INSTALL, TRANSCODE_PROVIDER: 'self-hosted' },
      'node',
    )
    expect(shape.transcodeProvider).toBe('self-hosted')
    expect(shape.selfHostedEnabled).toBe(true)
  })

  it('reports the analytics *read* path, which works on both runtimes', () => {
    const withToken = resolveDeployment(
      { ...MODAL_INSTALL, CLOUDFLARE_ANALYTICS_TOKEN: 'token' },
      'node',
    )
    expect(withToken.shape.analyticsRead).toBe('cloudflare-sql')
    expect(resolveDeployment(MODAL_INSTALL, 'node').shape.analyticsRead).toBe('none')
  })

  it('refuses a TCP Postgres on Workers', () => {
    const resolution = resolveDeployment({ ...MODAL_INSTALL, DB_DRIVER: 'pg' }, 'workers')

    expect(resolution.config.ready).toBe(false)
    expect(fatalProblems(resolution).join('\n')).toMatch(/DB_DRIVER=pg cannot work/)
  })

  it('allows a TCP Postgres on Node', () => {
    const resolution = resolveDeployment({ ...MODAL_INSTALL, DB_DRIVER: 'pg' }, 'node')
    expect(fatalProblems(resolution)).toEqual([])
  })

  it('refuses a TCP REDIS_URL on Workers instead of silently going per-isolate', () => {
    const resolution = resolveDeployment(
      { ...MODAL_INSTALL, REDIS_URL: 'redis://localhost:6379' },
      'workers',
    )

    expect(fatalProblems(resolution).join('\n')).toMatch(/REDIS_URL is set but/)
    // Falls back to the next available store rather than refusing to limit at all.
    expect(resolution.shape.rateLimitStore).toBe('memory')
  })

  it('selects Redis over Upstash over memory on Node', () => {
    const upstash = { UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }

    expect(
      resolveDeployment({ ...MODAL_INSTALL, ...upstash }, 'node').shape.rateLimitStore,
    ).toBe('upstash')
    expect(
      resolveDeployment({ ...MODAL_INSTALL, ...upstash, REDIS_URL: 'redis://localhost:6379' }, 'node')
        .shape.rateLimitStore,
    ).toBe('redis')
    expect(resolveDeployment(MODAL_INSTALL, 'node').shape.rateLimitStore).toBe('memory')
  })

  it('refuses an unrecognised TRANSCODE_PROVIDER rather than quietly keeping modal', () => {
    const resolution = resolveDeployment(
      { ...MODAL_INSTALL, TRANSCODE_PROVIDER: 'inhouse' },
      'node',
    )
    expect(fatalProblems(resolution).join('\n')).toMatch(/TRANSCODE_PROVIDER/)
  })

  it('keeps a missing optional capability non-fatal so the API can still boot', () => {
    const resolution = resolveDeployment({ DB_DRIVER: 'pg' }, 'node')

    expect(fatalProblems(resolution)).toEqual([])
    expect(resolution.problems.length).toBeGreaterThan(0)
    expect(resolution.config.ready).toBe(false)
  })
})
