import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema'

export type Db = ReturnType<typeof drizzle<typeof schema>>

function postgresOptions(url: string): postgres.Options<{}> {
  const options: postgres.Options<{}> = {
    max: 10,
    connection: { application_name: 'clipmux-api' },
  }
  const host = (url.split('@').pop() || '').split('/')[0] || ''
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1')
  if (/sslmode=require|sslmode=verify-full/.test(url) && !isLocal) {
    options.ssl = { rejectUnauthorized: false }
  }
  return options
}

/**
 * Build a schema-aware postgres-js Drizzle client for an explicit URL.
 *
 * A factory rather than a cached singleton: the returned instance belongs to the
 * caller, so a composition root installs exactly one and a test can build one
 * against a scratch database without racing a module-level cache.
 */
export function createDb(databaseUrl: string): Db {
  const client = postgres(databaseUrl, postgresOptions(databaseUrl))
  return drizzle(client, { schema })
}

let installed: Db | null = null

/**
 * Install the client this process will use.
 *
 * The composition roots are the only callers. There is deliberately no lazy
 * ambient-environment fallback: that is what let `db` resolve credentials from
 * `process.env` and appear to work only after a middleware had copied bindings
 * into it.
 */
export function installDb(instance: Db): void {
  installed = instance
}

/** Uninstall. Tests only — a second `installDb` in production is a bug. */
export function resetInstalledDb(): void {
  installed = null
}

/** Whether a client (real or placeholder) has been installed. */
export function hasInstalledDb(): boolean {
  return installed !== null
}

/**
 * The handle for a deployment with no `DATABASE_URL`.
 *
 * The API is documented to boot without a database: `/health` answers, and
 * `/health/config` reports `database: false` so a half-configured installation
 * can say what is missing rather than crash-looping. That only works if
 * something is installed, because better-auth's drizzle adapter dereferences
 * `db._.schema` while *constructing* the adapter — so this returns a handle that
 * satisfies construction and throws a precise error on the first real query.
 */
export function unconfiguredDb(): Db {
  return new Proxy({} as Db, {
    get(_target, prop) {
      if (prop === '_') {
        return { schema: undefined, fullSchema: undefined }
      }
      throw new Error(
        `DATABASE_URL is not configured, so db.${String(prop)} cannot run. Set ` +
          'DATABASE_URL (see server/.dev.vars.example) or use `pnpm dev:infra`.',
      )
    },
  })
}

export function getInstalledDb(): Db {
  if (!installed) {
    throw new Error(
      'Database is not installed: the runtime composition root must call ' +
        'installDb() before the first query.',
    )
  }
  return installed
}

/**
 * The app-wide handle.
 *
 * Still a proxy so ~30 existing call sites (`db.select(...)`) keep working, but
 * it now resolves to the one installed client instead of consulting the
 * environment on every property access.
 */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const instance = getInstalledDb()
    return (instance as unknown as Record<string, unknown>)[prop as string]
  },
})
