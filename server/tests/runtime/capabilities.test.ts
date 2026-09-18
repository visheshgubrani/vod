import { afterEach, describe, expect, it } from 'vitest'
import {
  db,
  getInstalledDb,
  hasInstalledDb,
  installDb,
  resetInstalledDb,
  unconfiguredDb,
} from '../../src/lib/database'
import { getR2, installR2, resetInstalledR2, createR2Client } from '../../src/utils/R2'
import { createNodeRuntime } from '../../src/runtime/node'

/**
 * The handles are install-once.
 *
 * This is the enforcement of the boundary: `db` and `r2` used to resolve their
 * credentials from `process.env` on every property access. A missing install
 * must therefore be an error, not a silent fallback.
 */

const COMPLETE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@db.example.com/clipmux',
  BETTER_AUTH_SECRET: 'a-32-character-secret-string-1234567890',
  JWT_SECRET: 'another-32-character-secret-string-9876543',
  ACCOUNT_ID: 'cf-account-123',
  R2_ACCESS_KEY_ID: 'r2-access-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret-key',
  TRANSCODED_BUCKET_NAME: 'transcoded-media',
  RAW_BUCKET_NAME: 'raw-uploads',
  MODAL_WEBHOOK_URL: 'https://user--app.modal.run/transcode',
  TRANSCODE_INGEST_SECRET: 'ingest-secret',
}

afterEach(() => {
  resetInstalledDb()
  resetInstalledR2()
})

describe('database handle', () => {
  it('throws before installation instead of reading the ambient environment', () => {
    resetInstalledDb()
    expect(hasInstalledDb()).toBe(false)
    expect(() => getInstalledDb()).toThrow(/not installed/)
    expect(() => db.select).toThrow(/not installed/)
  })

  it('resolves to the installed instance', () => {
    installDb(unconfiguredDb())
    expect(hasInstalledDb()).toBe(true)
    // The placeholder must satisfy adapter construction (better-auth reads
    // `db._.schema`) but refuse to pretend a query can run.
    expect(() => (db as unknown as Record<string, unknown>)['_']).not.toThrow()
    expect(() => db.select).toThrow(/DATABASE_URL is not configured/)
  })
})

describe('object storage handle', () => {
  it('throws before installation', () => {
    resetInstalledR2()
    expect(() => getR2()).toThrow(/not installed/)
  })

  it('returns the installed client', () => {
    const client = createR2Client({
      accountId: 'acct',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    })
    installR2(client)
    expect(getR2()).toBe(client)
  })
})

describe('composition root', () => {
  it('resolves the Node runtime', () => {
    expect(createNodeRuntime(COMPLETE_ENV).runtime).toBe('node')
  })

  it('exposes the resolved deployment shape for /health/config', () => {
    const node = createNodeRuntime(COMPLETE_ENV)
    expect(node.shape).toMatchObject({
      runtime: 'node',
      dbTransport: 'postgres-js',
      deliveryRuntime: 'cloudflare-worker',
    })
  })

  it('forwards playback analytics when ingest is configured', () => {
    const runtime = createNodeRuntime({
      ...COMPLETE_ENV,
      DELIVERY_URL: 'https://media.example.com',
      ANALYTICS_INGEST_SECRET: 'analytics-ingest-secret-32-chars-min',
    })
    expect(runtime.analytics.canWritePlayback).toBe(true)
    expect(runtime.shape.analyticsWrite).toBe('delivery-worker')
  })
})
