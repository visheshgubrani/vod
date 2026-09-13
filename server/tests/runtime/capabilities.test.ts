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
import { getWorkersRuntime, resetWorkersRuntime, withRequestContext } from '../../src/runtime/workers'
import { stringBindings } from '../../src/runtime/bindings'
import type { Bindings } from '../../src/types'

/**
 * The handles are install-once.
 *
 * This is the enforcement of the boundary: `db` and `r2` used to resolve their
 * credentials from `process.env` on every property access, which worked on
 * Workers only because a middleware had copied bindings into it per request. A
 * missing install must therefore be an error, not a silent fallback.
 */

const COMPLETE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@db.example.com/neondb',
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
  resetWorkersRuntime()
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

describe('stringBindings', () => {
  it('keeps strings and drops non-string bindings', () => {
    const env = stringBindings({
      DATABASE_URL: 'postgresql://x',
      EMPTY: undefined,
      PLAYBACK_ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Bindings)

    expect(env).toEqual({ DATABASE_URL: 'postgresql://x' })
  })
})

describe('composition roots', () => {
  it('produce the same capability shape', () => {
    const node = createNodeRuntime(COMPLETE_ENV)
    const workers = getWorkersRuntime(COMPLETE_ENV as unknown as Bindings)

    const keysOf = (value: object) => Object.keys(value).sort()
    // `forRequest` is Workers-only by design: the background runner needs the
    // invocation's context, which Node does not have.
    expect(keysOf(workers).filter((key) => key !== 'forRequest')).toEqual(keysOf(node))
  })

  it('resolve the runtime they were built for', () => {
    expect(createNodeRuntime(COMPLETE_ENV).runtime).toBe('node')
    expect(getWorkersRuntime(COMPLETE_ENV as unknown as Bindings).runtime).toBe('workers')
  })

  it('memoise the Workers runtime per bindings object', () => {
    const bindings = COMPLETE_ENV as unknown as Bindings
    expect(getWorkersRuntime(bindings)).toBe(getWorkersRuntime(bindings))

    const other = { ...COMPLETE_ENV } as unknown as Bindings
    expect(getWorkersRuntime(other)).not.toBe(getWorkersRuntime(bindings))
  })

  it('bind background work per request on Workers', () => {
    const isolate = getWorkersRuntime(COMPLETE_ENV as unknown as Bindings)
    const seen: Promise<unknown>[] = []
    const capability = withRequestContext(isolate, {
      waitUntil: (work) => seen.push(work),
    })

    capability.background(Promise.resolve('done'), 'test task')
    expect(seen).toHaveLength(1)

    // The isolate object is a complete capability set too, but scheduling
    // outside a request is a wiring bug and must say so.
    expect(() => isolate.background(Promise.resolve(), 'stray')).toThrow(
      /outside a request/,
    )
  })

  it('expose the resolved deployment shape for /health/config', () => {
    const node = createNodeRuntime({ ...COMPLETE_ENV, DB_DRIVER: 'pg' })
    expect(node.shape).toMatchObject({
      runtime: 'node',
      dbTransport: 'postgres-js',
      deliveryRuntime: 'cloudflare-worker',
    })
  })
})
