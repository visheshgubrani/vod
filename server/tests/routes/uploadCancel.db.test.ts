/**
 * `DELETE /api/upload/:fileId` — the dashboard's cancel/cleanup endpoint —
 * against a real PostgreSQL and a recording object store.
 *
 * The bug this suite pins down: the handler read the row, checked
 * `status IN ('uploading','failed')` in JavaScript, and *then* deleted the raw
 * object and the row in separate statements. An upload that completed while the
 * request was in flight — the single-PUT path calls `/upload/complete`
 * concurrently, which is the same interleaving `uploadUrl.db.test.ts` covers —
 * therefore had its R2 object deleted after the row had already been claimed
 * for transcoding: the Modal worker started, then 404'd on `HeadObject`, and
 * the video vanished from R2 with nothing left to retry. The dashboard
 * triggered it on every successful upload, because Uppy's `cancelAll()` during
 * modal teardown emits `file-removed`, which this endpoint is wired to.
 *
 * The read-then-write shape cannot be caught by re-reading the row later: by
 * the time the handler writes, the row it read is gone. So the second test
 * reproduces the interleaving instead — the handler's `video` read is handed to
 * it, and only then does a concurrent claim flip the row to `processing`, which
 * is exactly what `/upload/complete` does a few milliseconds into its own
 * request. What the endpoint does next is the whole test.
 *
 * The session is not under test, so the auth capability is stubbed; the route,
 * the auth middleware, the database and the S3 call sites are real. Application
 * modules are imported inside the suite on purpose: importing `lib/database` at
 * file scope throws without `DATABASE_URL`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { S3Client } from '@aws-sdk/client-s3'
import { createApp } from '../../src/app'
import { video } from '../../src/db/schema'
import { installDb, resetInstalledDb, type Db } from '../../src/lib/database'
import { installR2, resetInstalledR2 } from '../../src/utils/R2'
import type { Auth } from '../../src/lib/auth'
import type { RuntimeCapabilities } from '../../src/runtime/types'
import { createNodeRequestHandler, createNodeRuntime } from '../../src/runtime/node'
import { createTestDb, hasTestDatabase, type TestDb, type TestDbHandle } from '../helpers/db'
import { fullyConfiguredEnv } from '../helpers/runtime'

const ORG = 'org-upload-cancel'
const OTHER_ORG = 'org-upload-cancel-other'
const USER = 'user-upload-cancel'
const RAW_BUCKET = 'clipmux-raw'

/** Signed in as this user in this organization: the session is not under test. */
function signedInAs(runtime: RuntimeCapabilities): RuntimeCapabilities {
  return {
    ...runtime,
    auth: {
      api: {
        getSession: async () => ({
          user: { id: USER, name: 'Uploader', email: 'uploader@example.com' },
          session: { id: 'session-upload-cancel', userId: USER, activeOrganizationId: ORG },
        }),
      },
    } as unknown as Auth,
  }
}

/** Every S3 command the route tried to run, in order. */
type SentCommand = { name: string; input: Record<string, unknown> }

function recordingR2(sent: SentCommand[]): S3Client {
  return {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input })
      // `{}` is the empty-transcoded-bucket answer for ListObjectsV2.
      return {}
    },
  } as unknown as S3Client
}

/**
 * The installed database, wrapped so that the first write the handler runs is
 * preceded by `claim()`.
 *
 * This is how the concurrent writer is injected deterministically: `/upload/complete`
 * claims the row for transcoding (uploading -> processing, attempt recorded)
 * while the cancel request is in flight, and the cancel's destructive statement
 * then finds a row it must not touch. Neither a status checked in JavaScript
 * before the write nor a write with no status guard at all can see that — which
 * is the whole bug. Writes are intercepted because that is the point the
 * guarantee has to hold at; a read is not what destroys an upload.
 *
 * Every method on the builder chain is wrapped, because drizzle statements are
 * lazy and execute on whichever chained call the caller awaits.
 */
function dbClaimingBeforeFirstWrite(real: TestDb, claim: () => Promise<void>): Db {
  const state = { pending: true }

  function gated(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value
    return new Proxy(value as object, {
      get(target, prop, receiver) {
        const inner = Reflect.get(target, prop, receiver)
        if (prop === 'then') {
          return (onFulfilled: unknown, onRejected: unknown) => {
            const gate = state.pending ? ((state.pending = false), claim()) : Promise.resolve()
            return gate
              .then(() => Promise.resolve(target as PromiseLike<unknown>))
              .then(onFulfilled as never, onRejected as never)
          }
        }
        if (typeof inner === 'function') {
          return (...args: unknown[]) =>
            gated((inner as (...a: unknown[]) => unknown).apply(target, args))
        }
        return inner
      },
    })
  }

  const WRITES = new Set(['delete', 'update', 'insert'])
  return new Proxy(real as unknown as object, {
    get(target, prop, receiver) {
      const inner = Reflect.get(target, prop, receiver)
      if (typeof inner !== 'function') return inner
      if (!WRITES.has(String(prop))) return inner.bind(target)
      return (...args: unknown[]) =>
        gated((inner as (...a: unknown[]) => unknown).apply(target, args))
    },
  }) as unknown as Db
}

describe.skipIf(!hasTestDatabase)(
  'DELETE /api/upload/:fileId (PostgreSQL, Node wiring)',
  () => {
    let handle: TestDbHandle

    beforeAll(async () => {
      handle = await createTestDb({ database: 'upload_cancel_route' })
      await handle.exec(`
        INSERT INTO organization (id, name, slug, created_at)
        VALUES ('${ORG}', 'Upload Cancel', 'upload-cancel', now()),
               ('${OTHER_ORG}', 'Other Org', 'upload-cancel-other', now());
        INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ('${USER}', 'Uploader', 'uploader@example.com', true, now(), now());
      `)
    })

    afterEach(() => {
      resetInstalledR2()
      resetInstalledDb()
    })

    afterAll(async () => {
      await handle?.close()
      resetInstalledDb()
    })

    /** A video row plus a fresh runtime and a recording object store. */
    async function scenario(row: {
      id: string
      status: 'uploading' | 'processing' | 'ready' | 'failed'
      organizationId?: string
      interleave?: () => Promise<void>
    }) {
      const rawKey = `${ORG}/raw/${row.id}/clip.webm`
      await handle.exec(`
        INSERT INTO video (id, organization_id, title, status, playback_policy, raw_key, size, uploaded_by, created_at, updated_at)
        VALUES ('${row.id}', '${row.organizationId ?? ORG}', 'Clip', '${row.status}', 'public', '${rawKey}', 2048, '${USER}', now(), now());
      `)

      const runtime = createNodeRuntime(
        fullyConfiguredEnv({
          DATABASE_URL: handle.url,
          UPLOADS_ENABLED: 'true',
          RAW_BUCKET_NAME: RAW_BUCKET,
          TRANSCODED_BUCKET_NAME: 'clipmux-transcoded',
        }),
      )
      if (row.interleave) {
        // After the runtime, so this replaces the handle it installed.
        installDb(dbClaimingBeforeFirstWrite(handle.db, row.interleave))
      }

      const sent: SentCommand[] = []
      installR2(recordingR2(sent))

      const call = createNodeRequestHandler(createApp(signedInAs(runtime)), runtime)
      return { rawKey, sent, call }
    }

    async function cancel(call: (request: Request) => Response | Promise<Response>, fileId: string) {
      return call(
        new Request(`http://localhost/api/upload/${fileId}`, {
          method: 'DELETE',
          headers: { origin: 'http://localhost:3000' },
        }),
      )
    }

    const rawDeletions = (sent: SentCommand[]) =>
      sent.filter(
        (command) =>
          command.name === 'DeleteObjectCommand' && command.input.Bucket === RAW_BUCKET,
      )

    it('leaves a claimed upload and its bytes alone when the claim lands mid-request', async () => {
      const fileId = '11111111-1111-4111-8111-111111111111'
      // The claim `/upload/complete` performs while its own request is in
      // flight: `status` moves uploading -> processing and an attempt is
      // recorded before the transcode job is dispatched.
      const claim = async () => {
        await handle.exec(
          `UPDATE video SET status = 'processing', transcode_attempt_id = 'attempt-1'
           WHERE id = '${fileId}';`,
        )
      }
      const { sent, call } = await scenario({ id: fileId, status: 'uploading', interleave: claim })

      const response = await cancel(call, fileId)

      // The claim won: the row is no longer a cancellable upload, so neither it
      // nor the object a running job depends on may be touched.
      expect(response.status).toBe(400)
      const rows = await handle.db.select().from(video).where(eq(video.id, fileId))
      expect(rows).toHaveLength(1)
      expect(rows[0].transcodeAttemptId).toBe('attempt-1')
      expect(sent).toEqual([])
    })

    it('refuses to cancel a video that is already being transcoded', async () => {
      const fileId = '22222222-2222-4222-8222-222222222222'
      const { sent, call } = await scenario({ id: fileId, status: 'processing' })

      const response = await cancel(call, fileId)

      expect(response.status).toBe(400)
      const rows = await handle.db.select().from(video).where(eq(video.id, fileId))
      expect(rows).toHaveLength(1)
      expect(sent).toEqual([])
    })

    it('deletes the row and the raw object for an upload that never completed', async () => {
      const fileId = '33333333-3333-4333-8333-333333333333'
      const { rawKey, sent, call } = await scenario({ id: fileId, status: 'uploading' })

      const response = await cancel(call, fileId)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ deleted: true, fileId })

      const rows = await handle.db.select().from(video).where(eq(video.id, fileId))
      expect(rows).toHaveLength(0)

      const deleted = rawDeletions(sent)
      expect(deleted).toHaveLength(1)
      expect(deleted[0].input).toMatchObject({ Bucket: RAW_BUCKET, Key: rawKey })
    })

    it('answers idempotently for a row that is already gone', async () => {
      const fileId = '44444444-4444-4444-8444-444444444444'
      const { sent, call } = await scenario({ id: fileId, status: 'uploading' })
      await handle.exec(`DELETE FROM video WHERE id = '${fileId}';`)

      const response = await cancel(call, fileId)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ deleted: true, fileId })
      expect(sent).toEqual([])
    })

    it('never touches another organization’s upload', async () => {
      const fileId = '55555555-5555-4555-8555-555555555555'
      const { sent, call } = await scenario({
        id: fileId,
        status: 'uploading',
        organizationId: OTHER_ORG,
      })

      const response = await cancel(call, fileId)

      expect(response.status).toBe(403)
      const rows = await handle.db.select().from(video).where(eq(video.id, fileId))
      expect(rows).toHaveLength(1)
      expect(sent).toEqual([])
    })
  },
)
