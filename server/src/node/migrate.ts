/**
 * Zero-touch database migration runner — executed by the container entrypoint
 * BEFORE the API boots (docker/entrypoint.sh). Idempotent: drizzle tracks
 * applied migrations in __drizzle_migrations, and a Postgres advisory lock
 * prevents parallel replicas from racing the same pass.
 */
import '../lib/load-local-env'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import * as schema from '../db/schema'

const MIGRATION_LOCK_KEY = 872_342_011 // arbitrary constant advisory-lock key

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set — cannot run migrations')
  }

  const migrationsFolder = path.join(process.cwd(), 'drizzle')
  const client = postgres(url, { max: 1 })
  try {
    // Serialize concurrent booting replicas.
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    console.log('[migrate] schema up to date (postgres-js)')
  } finally {
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => undefined)
    await client.end().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
