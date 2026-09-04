import { neon } from '@neondatabase/serverless'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http'
import postgres from 'postgres'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema'
import type { Bindings } from '../types'

export type DbDriver = 'neon-http' | 'postgres-js'

/**
 * Choose the Postgres driver:
 * - DB_DRIVER=pg | postgres-js  -> postgres.js over TCP (Docker/Node/VPS)
 * - DB_DRIVER=neon | neon-http  -> Neon HTTP driver (Cloudflare Workers)
 * - unset                        -> neon-http (Workers heritage; set DB_DRIVER
 *                                   explicitly for other runtimes)
 */
export function dbDriverFromEnv(driver?: string | null): DbDriver {
  const value = (driver || '').trim().toLowerCase()
  if (value === 'pg' || value === 'postgres-js') return 'postgres-js'
  return 'neon-http'
}

function postgresOptions(url: string): postgres.Options<{}> {
  const options: postgres.Options<{}> = {
    max: 10,
    connection: { application_name: 'openvod-api' },
  }
  const host = (url.split('@').pop() || '').split('/')[0] || ''
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1')
  if (/sslmode=require|sslmode=verify-full/.test(url) && !isLocal) {
    options.ssl = { rejectUnauthorized: false }
  }
  return options
}

let cachedDb: ReturnType<typeof drizzleNeon> | null = null
let cachedKey: string | null = null

export function getDb(databaseUrl?: string, env?: Bindings) {
  const url =
    databaseUrl ||
    env?.DATABASE_URL ||
    (typeof process !== 'undefined' ? process.env?.DATABASE_URL : undefined)
  if (!url) {
    throw new Error('DATABASE_URL is not configured')
  }

  const driver = dbDriverFromEnv(
    env?.DB_DRIVER ?? (typeof process !== 'undefined' ? process.env?.DB_DRIVER : undefined),
  )
  const key = `${driver}:${url}`
  if (cachedDb && cachedKey === key) {
    return cachedDb
  }

  if (driver === 'postgres-js') {
    const client = postgres(url, postgresOptions(url))
    cachedDb = drizzlePg(client, { schema }) as unknown as ReturnType<typeof drizzleNeon>
  } else {
    const sql = neon(url)
    cachedDb = drizzleNeon(sql, { schema })
  }
  cachedKey = key
  return cachedDb
}

export const db = new Proxy({} as ReturnType<typeof drizzleNeon>, {
  get(_target, prop) {
    const instance = getDb()
    return (instance as unknown as Record<string, unknown>)[prop as string]
  },
})
