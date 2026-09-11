import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDb,
  hasTestDatabase,
  testDatabaseUrl,
  type TestDbHandle,
} from '../helpers/db'

/**
 * The `account` table against the installed better-auth.
 *
 * Why this suite exists: better-auth 1.7.0–1.7.2 required an `issuer` column on
 * `account` that this schema does not have, and the Drizzle adapter rejects the
 * whole request before issuing any SQL:
 *
 *   The field "issuer" does not exist in the "account" Drizzle schema.
 *
 * That surfaced as a bare HTTP 500 on `POST /api/auth/sign-up/email`. Nothing
 * caught it, because no test exercised the auth tables at all — the lockfile had
 * drifted to 1.7.2 under a `^1.4.x` range while the schema still described the
 * 1.6 shape. The failure was structural, not environmental: it was reachable
 * from every account-creating path (email sign-up, first-time social login,
 * account linking), and no configuration could satisfy it, because the `issuer`
 * value is written by better-auth itself.
 *
 * So this suite asserts the observed contract rather than the library's
 * internals: an account can be created, it can be signed in, and the row left
 * behind has the shape the migrations define. A future version that needs a
 * column this schema does not declare fails here, not in production.
 */

const SUITE_DATABASE = 'openvod_t_account'

const TEST_EMAIL = 'account-schema@example.invalid'
const TEST_PASSWORD = 'account-schema-password-1'
const TEST_NAME = 'Account Schema'

// Must point at THIS suite's database before application code is imported: the
// `db` proxy in src/lib/database.ts resolves DATABASE_URL lazily on first use,
// and a shared database would put other suites' rows in reach of these queries.
const PREVIOUS_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  DB_DRIVER: process.env.DB_DRIVER,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
}

process.env.DATABASE_URL = testDatabaseUrl(SUITE_DATABASE)
process.env.DB_DRIVER = 'pg'
// better-auth requires a secret for the credential flow. Tests read no env file
// (src/lib/auth.ts has no dotenv load), so it is supplied here explicitly.
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? 'test-secret-32-chars-minimum-1234567890'

type AuthApi = typeof import('../../src/lib/auth').auth.api

/** The `account` columns this schema declares — the shape sign-in depends on. */
const ACCOUNT_COLUMNS = `
  SELECT column_name, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'account'
  ORDER BY column_name
`

/**
 * Remove this suite's user, and its accounts/sessions by cascade.
 *
 * Sign-up creates the `user` row first and links the account second, so a
 * failure between the two leaves an orphaned user with no credential account —
 * sign-in then fails with "Invalid email or password" rather than "User not
 * found". Without this reset, the later tests would inherit that state and the
 * suite's result would depend on test order.
 */
function resetTestUser(): string {
  return `DELETE FROM "user" WHERE email = '${TEST_EMAIL}'`
}

describe.skipIf(!hasTestDatabase)('auth account table (real schema, real better-auth)', () => {
  let handle: TestDbHandle
  let api: AuthApi

  beforeAll(async () => {
    handle = await createTestDb({ database: SUITE_DATABASE })
    // Imported after DATABASE_URL is pointed at the suite database. A fake
    // adapter cannot establish this: the failure was between better-auth's
    // resolved table definition and the real migrated columns.
    api = (await import('../../src/lib/auth')).auth.api
  })

  afterAll(async () => {
    await handle?.close()
    // This file runs serially with every other suite, so a mutated environment
    // would follow it into their module graphs.
    for (const [key, value] of Object.entries(PREVIOUS_ENV)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  // Each test states its own precondition rather than inheriting the previous
  // test's rows.
  beforeEach(async () => {
    await handle.exec(resetTestUser())
  })

  /** Create the suite's credential account. Returns the created user. */
  const givenCredentialAccount = async () => {
    const created = await api.signUpEmail({
      body: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: TEST_NAME,
      },
    })
    return created.user
  }

  // The reported bug, at the boundary that returned 500.
  it('creates a credential account without requiring a column the schema lacks', async () => {
    const user = await givenCredentialAccount()

    expect(user.email).toBe(TEST_EMAIL)
  })

  it('signs in with the account it created', async () => {
    const user = await givenCredentialAccount()

    const result = await api.signInEmail({
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
    })

    expect(result.token).toBeTruthy()
    expect(result.user.id).toBe(user.id)
    expect(result.user.email).toBe(TEST_EMAIL)
  })

  /**
   * The persisted row is what the migrations control, so assert it directly
   * rather than trusting the adapter's in-memory view of the insert.
   */
  it('stores the credential account under the columns this schema defines', async () => {
    const user = await givenCredentialAccount()

    const rows = (await handle.exec(
      `SELECT provider_id, account_id, user_id
       FROM account WHERE user_id = '${user.id}'`,
    )) as Array<Record<string, unknown>>

    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider_id).toBe('credential')
    // Credential accounts are keyed by the user id, not by an email.
    expect(rows[0]!.account_id).toBe(user.id)
  })

  /**
   * A schema tripwire, not a behavioural assertion.
   *
   * The three tests above are what actually catch a required-column
   * requirement. This one records the intended shape explicitly, so the
   * decision not to carry `issuer` is visible in the suite rather than implied
   * by a missing line.
   */
  it('declares the account columns the credential flow depends on', async () => {
    const columns = (await handle.exec(ACCOUNT_COLUMNS)) as Array<{
      column_name: string
      is_nullable: string
    }>
    const byName = new Map(columns.map((c) => [c.column_name, c]))

    // The 1.6/1.7.4 contract: these exist and are nullable where stated.
    for (const name of [
      'id',
      'account_id',
      'provider_id',
      'user_id',
      'password',
      'created_at',
      'updated_at',
    ]) {
      expect(byName.has(name), `account.${name} is missing`).toBe(true)
    }

    expect(byName.get('account_id')!.is_nullable).toBe('NO')
    expect(byName.get('provider_id')!.is_nullable).toBe('NO')
    expect(byName.get('password')!.is_nullable).toBe('YES')

    // `issuer` was required only by 1.7.0–1.7.2 and was dropped again in
    // 1.7.3 as a schema change with no data migration. Adding it here would be
    // adopting a column the library itself reverted, so its absence is
    // deliberate: if a future version starts writing it, that decision has to
    // be made here rather than assumed.
    expect(byName.has('issuer')).toBe(false)
  })
})
