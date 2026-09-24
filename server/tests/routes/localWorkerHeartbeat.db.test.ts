import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Auth } from '../../src/lib/auth'
import type { RuntimeCapabilities } from '../../src/runtime/types'
import { createTestDb, hasTestDatabase, testDatabaseUrl, type TestDbHandle } from '../helpers/db'
import { createTestRuntime, fullyConfiguredEnv, withRuntime } from '../helpers/runtime'
import { resetInstalledDb } from '../../src/lib/database'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTRACT = JSON.parse(
  readFileSync(resolve(HERE, '../../../contracts/local-worker-heartbeat.json'), 'utf8'),
) as Record<string, unknown>
const SUITE = 'local_worker_heartbeat'
const suiteUrl = testDatabaseUrl(SUITE)
if (suiteUrl) process.env.DATABASE_URL = suiteUrl

const WORKER_SECRET = 'local-worker-contract-secret-with-32-chars'
const ORG = 'org-local-worker-contract'
const OTHER_ORG = 'org-local-worker-contract-other'
const USER = 'user-local-worker-contract'
const VIDEO = '11111111-1111-4111-8111-111111111111'
const OTHER_VIDEO = '22222222-2222-4222-8222-222222222222'
const JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_JOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function runtime() {
  return createTestRuntime(
    fullyConfiguredEnv({
      DATABASE_URL: suiteUrl,
      TRANSCODE_PROVIDER: 'local',
      LOCAL_TRANSCODE_ENABLED: 'true',
      LOCAL_TRANSCODER_SECRET: WORKER_SECRET,
      LOCAL_IMPORT_ORG_ID: ORG,
    }),
  )
}

function signedIn(runtimeCapabilities: RuntimeCapabilities): RuntimeCapabilities {
  return {
    ...runtimeCapabilities,
    auth: {
      api: {
        getSession: async () => ({
          user: { id: USER, name: 'Worker test', email: 'worker-test@example.com' },
          session: { id: 'worker-test-session', userId: USER, activeOrganizationId: ORG },
        }),
      },
    } as unknown as Auth,
  }
}

describe.skipIf(!hasTestDatabase)('local worker heartbeat wire contract (PostgreSQL)', () => {
  let handle: TestDbHandle
  let transcoder: typeof import('../../src/routes/transcoder')['default']
  let dashboardApp: typeof import('../../src/routes/localImport')['dashboardApp']

  beforeAll(async () => {
    handle = await createTestDb({ database: SUITE })
    ;({ default: transcoder } = await import('../../src/routes/transcoder'))
    ;({ dashboardApp } = await import('../../src/routes/localImport'))
    await handle.exec(`
      INSERT INTO local_worker (id, capacity_jobs, capacity_renditions)
      VALUES ('local', 1, 1);
    `)
  })

  afterAll(async () => {
    await handle?.close()
    resetInstalledDb()
  })

  async function postHeartbeat(body: unknown) {
    return withRuntime(transcoder, runtime()).request('/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-local-transcoder-secret': WORKER_SECRET,
      },
      body: JSON.stringify(body),
    })
  }

  it('accepts the Python worker payload and persists configured capacity and version', async () => {
    const response = await postHeartbeat(CONTRACT)

    expect(response.status).toBe(200)
    const rows = await handle.exec(
      `SELECT capabilities, worker_version, capacity_jobs, capacity_renditions FROM local_worker WHERE id = 'local'`,
    ) as unknown as Array<{ capabilities: Record<string, unknown>; worker_version: string; capacity_jobs: number; capacity_renditions: number }>
    expect(rows[0]).toMatchObject({
      capabilities: CONTRACT.capabilities,
      worker_version: CONTRACT.workerVersion,
      capacity_jobs: CONTRACT.capacityJobs,
      capacity_renditions: CONTRACT.capacityRenditions,
    })
  })

  it('keeps worker metadata when a progress-only heartbeat omits it', async () => {
    await handle.exec(`
      UPDATE local_worker
      SET capabilities = '{"encoders":["cpu"],"ffmpeg":"7.1"}'::jsonb,
          worker_version = '1.0.0', hostname = 'contract-worker';
    `)

    const response = await postHeartbeat({
      progress: { jobId: JOB, attemptId: 'attempt-progress-only', stage: 'running' },
    })

    expect(response.status).toBe(200)
    const rows = await handle.exec(
      `SELECT capabilities, worker_version, hostname FROM local_worker WHERE id = 'local'`,
    ) as unknown as Array<{ capabilities: Record<string, unknown>; worker_version: string; hostname: string }>
    expect(rows[0]).toMatchObject({
      capabilities: { encoders: ['cpu'], ffmpeg: '7.1' },
      worker_version: '1.0.0',
      hostname: 'contract-worker',
    })
  })

  it('returns the deployment-wide active job count to the Encoding card', async () => {
    await handle.exec(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES
        ('${ORG}', 'Worker Contract', 'worker-contract', now()),
        ('${OTHER_ORG}', 'Other Contract Org', 'other-contract-org', now());
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${USER}', 'Worker test', 'worker-test@example.com', true, now(), now());
      INSERT INTO member (id, organization_id, user_id, role, created_at)
      VALUES ('worker-contract-member', '${ORG}', '${USER}', 'owner', now());
      INSERT INTO video (id, organization_id, title, status)
      VALUES
        ('${VIDEO}', '${ORG}', 'Active job', 'processing'),
        ('${OTHER_VIDEO}', '${OTHER_ORG}', 'Other active job', 'processing');
      INSERT INTO transcode_job (
        id, video_id, organization_id, provider, state, attempt_id, lease_owner, lease_expires_at
      ) VALUES
        ('${JOB}', '${VIDEO}', '${ORG}', 'local', 'running', 'attempt-active', 'local', now() + interval '10 minutes'),
        ('${OTHER_JOB}', '${OTHER_VIDEO}', '${OTHER_ORG}', 'local', 'running', 'attempt-other-active', 'local', now() + interval '10 minutes');
      UPDATE local_worker SET last_seen_at = now() WHERE id = 'local';
    `)
    const app = withRuntime(dashboardApp, signedIn(runtime()))

    const response = await app.request('/worker')
    const body = await response.json() as { worker: { activeJobs?: number } }

    expect(response.status).toBe(200)
    expect(body.worker.activeJobs).toBe(2)
  })
})
