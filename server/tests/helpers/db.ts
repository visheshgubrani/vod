/**
 * Real-database harness for integration tests.
 *
 * Atomicity, locking and lease behaviour cannot be established with fake
 * adapters — those guarantees live in Postgres, not in our code. Suites that
 * assert them must run against a real server.
 *
 * Convention (server/tests/README.md, CONTRIBUTING.md): read `TEST_DATABASE_URL`
 * and SKIP cleanly when it is unset, so `pnpm test` works on a laptop with no
 * Postgres while CI runs the same suite against a service container.
 *
 * Driver choice: CI/local Postgres is a plain server, so these tests use the
 * postgres-js driver. The neon-http driver is a Workers-only HTTP transport and
 * cannot be pointed at a local container; `normalizeRows` covers its result
 * shape without needing a live endpoint.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''

/** True when a real database is available; gate integration suites on this. */
export const hasTestDatabase = TEST_DATABASE_URL.length > 0

export type TestDb = ReturnType<typeof drizzle>

export type TestDbHandle = {
  db: TestDb
  /** Run raw SQL (schema setup/teardown). */
  exec: (statement: string) => Promise<unknown>
  close: () => Promise<void>
}

function isLocalHost(url: string): boolean {
  const host = (url.split('@').pop() ?? '').split('/')[0] ?? ''
  return host.startsWith('localhost') || host.startsWith('127.0.0.1')
}

/**
 * Open a handle to the test database.
 *
 * `max: 1` (the default) keeps a test's statements on one connection, which
 * matters for session-level behaviour. Concurrency tests need genuinely
 * independent connections — open a second handle, or pass `max: 2`.
 */
export function createTestDb(options: { max?: number } = {}): TestDbHandle {
  if (!hasTestDatabase) {
    throw new Error('TEST_DATABASE_URL is not set')
  }
  const client = postgres(TEST_DATABASE_URL, {
    max: options.max ?? 1,
    idle_timeout: 5,
    connection: { application_name: 'openvod-integration-test' },
    // `DROP TABLE IF EXISTS` emits a NOTICE that postgres-js prints to stdout
    // by default, drowning the test reporter. Schema setup is expected to be
    // noisy; real problems still surface as thrown errors.
    onnotice: () => {},
    ...(isLocalHost(TEST_DATABASE_URL) ? {} : { ssl: { rejectUnauthorized: false } }),
  })
  const db = drizzle(client)

  return {
    db,
    exec: (statement: string) => client.unsafe(statement),
    close: () => client.end({ timeout: 5 }),
  }
}
