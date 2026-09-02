import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from '../db/schema'
import type { Bindings } from '../types'

let cachedDb: ReturnType<typeof drizzle> | null = null
let cachedUrl: string | null = null

export function getDb(databaseUrl?: string, env?: Bindings) {
  const url =
    databaseUrl ||
    env?.DATABASE_URL ||
    (typeof process !== 'undefined' ? process.env?.DATABASE_URL : undefined)
  if (!url) {
    throw new Error('DATABASE_URL is not configured')
  }
  if (cachedDb && cachedUrl === url) {
    return cachedDb
  }
  const sql = neon(url)
  cachedDb = drizzle(sql, { schema })
  cachedUrl = url
  return cachedDb
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    const instance = getDb()
    return (instance as any)[prop]
  },
})


