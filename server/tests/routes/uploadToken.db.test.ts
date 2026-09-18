/**
 * `POST /api/upload/token` — the dashboard's upload-token handshake, against a
 * real PostgreSQL, served through the Node wiring.
 *
 * The dashboard uploads through the same public path an external integrator
 * uses (`/v1/upload/*` with `Authorization: UploadToken ut_…`), and the token
 * that authorises it is minted here, from a **session**. Two properties are
 * worth a test rather than a review:
 *
 *  - the row is scoped to the session's active organization, not to whatever a
 *    request body claims, and
 *  - `apiKeyId` is null: a session-minted token must not be attributed to an
 *    API key, because there is no key involved.
 *
 * The session is stubbed (auth is not under test); the route, the middleware,
 * the database and the rate limiter are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../src/app'
import { uploadToken } from '../../src/db/schema'
import { resetInstalledDb } from '../../src/lib/database'
import type { Auth } from '../../src/lib/auth'
import type { RuntimeCapabilities } from '../../src/runtime/types'
import { createNodeRequestHandler, createNodeRuntime } from '../../src/runtime/node'
import { createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'
import { fullyConfiguredEnv } from '../helpers/runtime'

const ORG = 'org-upload-token'
const USER = 'user-upload-token'

/** Signed in as this user in this organization: the session is not under test. */
function signedInAs(runtime: RuntimeCapabilities): RuntimeCapabilities {
  return {
    ...runtime,
    auth: {
      api: {
        getSession: async () => ({
          user: { id: USER, name: 'Uploader', email: 'uploader@example.com' },
          session: { id: 'session-upload-token', userId: USER, activeOrganizationId: ORG },
        }),
      },
    } as unknown as Auth,
  }
}

/** Signed in, but with no organization selected. */
function signedInWithoutOrg(runtime: RuntimeCapabilities): RuntimeCapabilities {
  return {
    ...runtime,
    auth: {
      api: {
        getSession: async () => ({
          user: { id: USER, name: 'Uploader', email: 'uploader@example.com' },
          session: { id: 'session-upload-token', userId: USER, activeOrganizationId: null },
        }),
      },
    } as unknown as Auth,
  }
}

describe.skipIf(!hasTestDatabase)('POST /api/upload/token (PostgreSQL, Node wiring)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'upload_token_route' })
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG}', 'Upload Token', 'upload-token', now());
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${USER}', 'Uploader', 'uploader@example.com', true, now(), now());
    `)
  })

  afterAll(async () => {
    await handle?.close()
    resetInstalledDb()
  })

  async function mint(runtime: RuntimeCapabilities, body: unknown = {}) {
    return createNodeRequestHandler(createApp(runtime), runtime)(
      new Request('http://localhost/api/upload/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify(body),
      }),
    )
  }

  it('mints a token bound to the session organization', async () => {
    const runtime = createNodeRuntime(
      fullyConfiguredEnv({ DATABASE_URL: handle.url }),
    )

    const response = await mint(signedInAs(runtime), { expires_in: '30m', max_files: 2 })
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      upload_token: string
      expires_at: string
      max_files: number
      max_size_bytes: number | null
    }

    expect(body.upload_token.startsWith('ut_')).toBe(true)
    expect(body.max_files).toBe(2)
    expect(body.max_size_bytes).toBeNull()

    const rows = await handle.db
      .select()
      .from(uploadToken)
      .where(eq(uploadToken.token, body.upload_token))

    expect(rows).toHaveLength(1)
    expect(rows[0].organizationId).toBe(ORG)
    expect(rows[0].apiKeyId).toBeNull()
    expect(rows[0].usedFiles).toBe(0)

    // 30 minutes, allowing for the seconds the request took.
    const ttlMs = new Date(body.expires_at).getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(29 * 60_000)
    expect(ttlMs).toBeLessThanOrEqual(30 * 60_000)
  })

  it('defaults to a one-hour, single-file token', async () => {
    const runtime = createNodeRuntime(
      fullyConfiguredEnv({ DATABASE_URL: handle.url }),
    )

    const body = (await (await mint(signedInAs(runtime))).json()) as {
      upload_token: string
      max_files: number
    }

    const rows = await handle.db
      .select()
      .from(uploadToken)
      .where(eq(uploadToken.token, body.upload_token))

    expect(body.max_files).toBe(1)
    const ttlMs = rows[0].expiresAt.getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(59 * 60_000)
    expect(ttlMs).toBeLessThanOrEqual(60 * 60_000)
  })

  it('refuses an expiration beyond the 24h ceiling', async () => {
    const runtime = createNodeRuntime(
      fullyConfiguredEnv({ DATABASE_URL: handle.url }),
    )

    const response = await mint(signedInAs(runtime), { expires_in: '48h' })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'expires_in cannot exceed 24h' })
  })

  it('rejects a max_files outside 1–100', async () => {
    const runtime = createNodeRuntime(
      fullyConfiguredEnv({ DATABASE_URL: handle.url }),
    )

    expect((await mint(signedInAs(runtime), { max_files: 0 })).status).toBe(400)
    expect((await mint(signedInAs(runtime), { max_files: 101 })).status).toBe(400)
  })

  it('requires an active organization', async () => {
    const runtime = createNodeRuntime(
      fullyConfiguredEnv({ DATABASE_URL: handle.url }),
    )

    const response = await mint(signedInWithoutOrg(runtime))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'No active organization' })
  })

  it('refuses an anonymous request', async () => {
    const runtime = createNodeRuntime(
      fullyConfiguredEnv({ DATABASE_URL: handle.url }),
    )
    const anonymous: RuntimeCapabilities = {
      ...runtime,
      auth: {
        api: { getSession: async () => null },
      } as unknown as Auth,
    }

    expect((await mint(anonymous)).status).toBe(401)
  })

  it('is refused when the deployment has uploads disabled', async () => {
    const runtime = createNodeRuntime(
      fullyConfiguredEnv({
        DATABASE_URL: handle.url,
        UPLOADS_ENABLED: 'false',
      }),
    )

    const response = await mint(signedInAs(runtime))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('UPLOADS_ENABLED'),
    })
  })
})
