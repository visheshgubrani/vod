/**
 * The dashboard's upload handshake — `POST /api/upload/url` — against a real
 * PostgreSQL, served exactly as the Node entrypoint serves it.
 *
 * The handler inserts the video row, mints the presigned PUT for the raw bucket
 * and then dispatches a `video.uploading` tenant webhook through
 * `c.executionCtx`. Hono's `executionCtx` getter throws when `fetch` was called
 * without a context, so a missing Node context turned a handshake that had
 * already written the row and signed the URL into `500 Internal server error`;
 * the only trace was "This context has no ExecutionContext" in the log, after
 * `[PRESIGNED URL GENERATED]`.
 *
 * The session is not under test here, so the auth capability is stubbed; the
 * route, the auth middleware, the database, the object-store client and the
 * presigner are the real ones. `createNodeRequestHandler` is the same wiring the
 * entrypoint uses — a suite that hand-rolled its own `fetch(request, env)`
 * instead would test the bug rather than catch it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../src/app'
import { video } from '../../src/db/schema'
import { resetInstalledDb } from '../../src/lib/database'
import type { Auth } from '../../src/lib/auth'
import type { RuntimeCapabilities } from '../../src/runtime/types'
import { createNodeRequestHandler, createNodeRuntime } from '../../src/runtime/node'
import { createTestDb, hasTestDatabase, type TestDbHandle } from '../helpers/db'
import { fullyConfiguredEnv } from '../helpers/runtime'

const ORG = 'org-upload-url'
const USER = 'user-upload-url'

/** Signed in as this user in this organization: the session is not under test. */
function signedInAs(runtime: RuntimeCapabilities): RuntimeCapabilities {
  return {
    ...runtime,
    auth: {
      api: {
        getSession: async () => ({
          user: { id: USER, name: 'Uploader', email: 'uploader@example.com' },
          session: { id: 'session-upload-url', userId: USER, activeOrganizationId: ORG },
        }),
      },
    } as unknown as Auth,
  }
}

describe.skipIf(!hasTestDatabase)('POST /api/upload/url (PostgreSQL, Node wiring)', () => {
  let handle: TestDbHandle

  beforeAll(async () => {
    handle = await createTestDb({ database: 'upload_url_route' })
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('${ORG}', 'Upload URL', 'upload-url', now());
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${USER}', 'Uploader', 'uploader@example.com', true, now(), now());
    `)
  })

  afterAll(async () => {
    await handle?.close()
    resetInstalledDb()
  })

  it('signs a PUT for the raw bucket and records the upload', async () => {
    // The composition root installs its own handle for this database, exactly as
    // a deployment does; `handle.db` is the suite's own connection to the same
    // database, used for the assertions.
    const runtime = createNodeRuntime(
      fullyConfiguredEnv({ DATABASE_URL: handle.url, DB_DRIVER: 'pg' }),
    )

    const response = await createNodeRequestHandler(createApp(signedInAs(runtime)), runtime)(
      new Request('http://localhost/api/upload/url', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({
          filename: 'clip.webm',
          contentType: 'video/webm',
          size: 2048,
          title: 'Why Women Start Equal',
        }),
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { uploadUrl: string; fileId: string; key: string }

    // Shape only, never the URL itself: a presigned URL is a credential.
    expect(body.uploadUrl.startsWith('https://')).toBe(true)
    expect(body.uploadUrl.includes('X-Amz-Signature=')).toBe(true)
    expect(body.key).toBe(`${ORG}/raw/${body.fileId}/clip.webm`)

    const rows = await handle.db.select().from(video).where(eq(video.id, body.fileId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      organizationId: ORG,
      title: 'Why Women Start Equal',
      status: 'uploading',
      rawKey: body.key,
      size: 2048,
      uploadedBy: USER,
    })
  })
})
