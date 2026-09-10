/**
 * Real-database harness for integration tests.
 *
 * Atomicity, locking, lease and trigger behaviour cannot be established with
 * fake adapters — those guarantees live in Postgres, not in our code. Suites
 * that assert them must run against a real server.
 *
 * ## Isolation
 *
 * Every suite gets its **own database**, created and migrated here. Sharing one
 * database across suites does not work, and the reasons are structural rather
 * than fixable by tidier cleanup:
 *
 * - the maintenance passes are *global by design* — `sendDueDeliveries` and
 *   `runObjectCleanup` claim whatever is due, not just what the current file
 *   created, so one suite's pending rows get sent and settled by another's run;
 * - `AFTER DELETE ON video` fires for every suite, so one suite's deletes
 *   enqueue cleanup jobs that another suite then reconciles;
 * - a shared database makes test order significant, so a suite that passes
 *   alone can fail in a full run.
 *
 * Scoping cleanup to "my organization" cannot fix any of that, because the
 * claimers genuinely do not care which organization a row belongs to.
 *
 * ## Migration
 *
 * Migrations are applied from the committed SQL, in journal order. Two things
 * depend on this:
 *
 * - CI starts from an empty database, so without it the suites fail with
 *   `relation "..." does not exist`;
 * - `drizzle-kit push` derives changes from the TypeScript schema and therefore
 *   **cannot** create the hand-written objects in migrations 0013/0014/0016
 *   (the `AFTER DELETE` cleanup trigger). Anything exercising those paths must
 *   be migrated, not pushed.
 *
 * Driver: these tests use postgres-js against a plain server. The neon-http
 * driver is a Workers-only HTTP transport and cannot be pointed at a local
 * container, so its result *shape* is covered by `normalizeRows` unit tests.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', '..', 'drizzle')

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''

/** True when a real database is available; gate integration suites on this. */
export const hasTestDatabase = TEST_DATABASE_URL.length > 0

export type TestDb = ReturnType<typeof drizzle>

export type TestDbHandle = {
  db: TestDb
  /** The suite's own database URL — point app code at this, not the base URL. */
  url: string
  /** Run raw SQL (schema setup/teardown). */
  exec: (statement: string) => Promise<unknown>
  close: () => Promise<void>
}

/**
 * URL of a suite's own database. Available synchronously so a suite can point
 * `process.env.DATABASE_URL` at it *before* importing application modules that
 * capture the connection lazily.
 */
export function testDatabaseUrl(name: string): string {
  if (!hasTestDatabase) return ''
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

function isLocalHost(url: string): boolean {
  const host = (url.split('@').pop() ?? '').split('/')[0] ?? ''
  return host.startsWith('localhost') || host.startsWith('127.0.0.1')
}

function clientOptions(url: string, max: number) {
  return {
    max,
    idle_timeout: 5,
    connection: { application_name: 'openvod-integration-test' },
    // `DROP DATABASE`/`DROP TABLE IF EXISTS` emit notices that postgres-js
    // prints to stdout, drowning the reporter.
    onnotice: () => {},
    ...(isLocalHost(url) ? {} : { ssl: { rejectUnauthorized: false } }),
  }
}

/**
 * Open an additional connection to a suite database that already exists.
 *
 * Concurrency tests need a genuinely independent connection. They must NOT call
 * `createTestDb`, which drops and recreates the database — doing that mid-suite
 * would destroy the rows the suite is working with.
 */
export async function connectTestDb(options: {
  database: string
  max?: number
}): Promise<TestDbHandle> {
  if (!hasTestDatabase) {
    throw new Error('TEST_DATABASE_URL is not set')
  }
  const url = testDatabaseUrl(options.database)
  const client = postgres(url, clientOptions(url, options.max ?? 1))
  return {
    db: drizzle(client),
    url,
    exec: (statement: string) => client.unsafe(statement),
    close: () => client.end({ timeout: 5 }),
  }
}

/**
 * Create a fresh, migrated database and connect to it.
 *
 * Drops any previous database of the same name, so a suite always starts from
 * a known-empty, fully-migrated state — including the hand-written trigger.
 */
export async function createTestDb(
  options: { database: string; max?: number },
): Promise<TestDbHandle> {
  if (!hasTestDatabase) {
    throw new Error('TEST_DATABASE_URL is not set')
  }

  const name = options.database
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe test database name: ${name}`)
  }

  const admin = postgres(TEST_DATABASE_URL, clientOptions(TEST_DATABASE_URL, 1))
  try {
    // FORCE disconnects any lingering session from an earlier run.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const url = testDatabaseUrl(name)
  const client = postgres(url, clientOptions(url, options.max ?? 1))
  const db = drizzle(client)

  // The same migrator `db:migrate` runs, so a migration that works in tests
  // cannot fail in a deployment (or vice versa), and `__drizzle_migrations`
  // bookkeeping matches production.
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })

  return {
    db,
    url,
    exec: (statement: string) => client.unsafe(statement),
    close: () => client.end({ timeout: 5 }),
  }
}
