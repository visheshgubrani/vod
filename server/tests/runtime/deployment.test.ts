import { describe, expect, it } from 'vitest'
import { fatalProblems, resolveDeployment } from '../../src/runtime/deployment'

/**
 * `resolveDeployment` is the single place every choosable axis is decided. These
 * tests pin the answers, because the previous arrangement decided them in
 * several places at once (`app.ts` at module scope, routes per request, the Node
 * entry from `process.env`) and the copies disagreed.
 */

const MODAL_INSTALL = {
  DATABASE_URL: 'postgresql://user:pass@db.example.com/clipmux',
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
    expect(() => resolveDeployment({})).not.toThrow()
    expect(() => resolveDeployment({ DB_DRIVER: 'neon-http' })).not.toThrow()
    expect(() => resolveDeployment({ REDIS_URL: 'x' })).not.toThrow()
  })

  it('resolves the Node postgres-js shape', () => {
    const { shape } = resolveDeployment({ ...MODAL_INSTALL, QSTASH_TOKEN: 'qs' })

    expect(shape).toMatchObject({
      runtime: 'node',
      dbTransport: 'postgres-js',
      rateLimitStore: 'memory',
      transcodeProvider: 'modal',
      selfHostedEnabled: false,
      modalDispatch: 'qstash',
      analyticsEnabled: true,
      analyticsWrite: 'none',
      deliveryRuntime: 'cloudflare-worker',
      deliveryUrl: 'https://media.example.com',
    })
  })

  it('defaults Modal dispatch to direct HTTP', () => {
    const { shape } = resolveDeployment(MODAL_INSTALL)
    expect(shape.modalDispatch).toBe('direct-http')
  })

  it('reports delivery-worker analytics write when ingest is configured', () => {
    expect(resolveDeployment(MODAL_INSTALL).shape.analyticsWrite).toBe('none')
    expect(
      resolveDeployment({
        ...MODAL_INSTALL,
        ANALYTICS_INGEST_SECRET: 'analytics-ingest-secret-32-chars-min',
      }).shape.analyticsWrite,
    ).toBe('delivery-worker')
    expect(
      resolveDeployment({
        ...MODAL_INSTALL,
        ANALYTICS_ENABLED: 'false',
        ANALYTICS_INGEST_SECRET: 'analytics-ingest-secret-32-chars-min',
      }).shape.analyticsWrite,
    ).toBe('none')
  })

  it('reports the self-hosted provider and its enablement', () => {
    const { shape } = resolveDeployment({
      ...MODAL_INSTALL,
      TRANSCODE_PROVIDER: 'self-hosted',
    })
    expect(shape.transcodeProvider).toBe('self-hosted')
    expect(shape.selfHostedEnabled).toBe(true)
  })

  it('reports the analytics read path only when analytics is enabled', () => {
    const withToken = resolveDeployment({
      ...MODAL_INSTALL,
      CLOUDFLARE_ANALYTICS_TOKEN: 'token',
    })
    expect(withToken.shape.analyticsRead).toBe('cloudflare-sql')
    expect(resolveDeployment(MODAL_INSTALL).shape.analyticsRead).toBe('none')
    expect(
      resolveDeployment({
        ...MODAL_INSTALL,
        CLOUDFLARE_ANALYTICS_TOKEN: 'token',
        ANALYTICS_ENABLED: 'false',
      }).shape.analyticsRead,
    ).toBe('none')
  })

  it('advises that DB_DRIVER is obsolete rather than selecting another driver', () => {
    const resolution = resolveDeployment({ ...MODAL_INSTALL, DB_DRIVER: 'neon-http' })
    expect(resolution.shape.dbTransport).toBe('postgres-js')
    expect(resolution.advisories.join('\n')).toMatch(/DB_DRIVER is no longer used/)
    expect(fatalProblems(resolution)).toEqual([])
  })

  it('selects Redis over Upstash over memory', () => {
    const upstash = {
      UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 't',
    }

    expect(resolveDeployment({ ...MODAL_INSTALL, ...upstash }).shape.rateLimitStore).toBe('upstash')
    expect(
      resolveDeployment({
        ...MODAL_INSTALL,
        ...upstash,
        REDIS_URL: 'redis://localhost:6379',
      }).shape.rateLimitStore,
    ).toBe('redis')
    expect(resolveDeployment(MODAL_INSTALL).shape.rateLimitStore).toBe('memory')
  })

  it('refuses an unrecognised TRANSCODE_PROVIDER rather than quietly keeping modal', () => {
    const resolution = resolveDeployment({
      ...MODAL_INSTALL,
      TRANSCODE_PROVIDER: 'inhouse',
    })
    expect(fatalProblems(resolution).join('\n')).toMatch(/TRANSCODE_PROVIDER/)
  })

  it('keeps a missing optional capability non-fatal so the API can still boot', () => {
    const resolution = resolveDeployment({})

    expect(fatalProblems(resolution)).toEqual([])
    expect(resolution.problems.length).toBeGreaterThan(0)
    expect(resolution.config.ready).toBe(false)
  })
})
