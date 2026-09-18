import { describe, expect, it } from 'vitest'
import {
  classifyDevDb,
  devInfraChoice,
  missingComposeFileMessage,
  parsePortOwners,
  portAllocatedMessage,
  quickFixFor,
  remediationFor,
} from '../src/devInfra'
import type { WizardAnswers } from '../src/types'

/**
 * The dev database is the one thing the wizard used to assume rather than
 * check. Every verdict below was captured from a real machine state: port 5433
 * held by another Compose project, and — the case that produced a running but
 * unreachable container — a Postgres Compose reports as healthy while Docker
 * never attached its network endpoint.
 */

const SECRET = 'a'.repeat(64)

function answers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    target: 'dev',
    db: { kind: 'local' },
    queue: { kind: 'direct' },
    rateLimit: { kind: 'memory' },
    accountId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    r2AccessKeyId: 'r2-key',
    r2SecretAccessKey: 'r2-secret',
    rawBucket: 'clipmux-raw',
    transcodedBucket: 'clipmux-transcoded',
    frontendUrl: 'http://localhost:3000',
    ...overrides,
  }
}

/** `docker ps --filter publish=5433 --format {{json .}}`, verbatim. */
const DOCENTO_PS_LINE =
  '{"Command":"\\"docker-entrypoint.s…\\"","CreatedAt":"2026-09-13 13:52:33 +0530 IST","HealthStatus":"healthy","ID":"582aaee6ae62","Image":"postgres:18-alpine","Labels":"com.docker.compose.config-hash=476368a08d61f8dfd9f8f062835dedd13ac5753cf34f783b700dac9f794cdc14,com.docker.compose.container-number=1,com.docker.compose.depends_on=,com.docker.compose.image=sha256:63bdc97d67b5133bf0e5ebd500bec6d046fa851dc81340d838f0347e616107e8,com.docker.compose.oneoff=False,com.docker.compose.project.config_files=/home/vishesh/docento/docker-compose.yml,/tmp/docento-pg-override.yml,com.docker.compose.project.working_dir=/home/vishesh/docento,com.docker.compose.project=docento,com.docker.compose.service=postgres,com.docker.compose.version=5.5.1","LocalVolumes":"2","Mounts":"22118f319a3677…,docento_postgr…","Names":"docento-postgres-1","Networks":"docento_default","Platform":{"architecture":"amd64","os":"linux"},"Ports":"0.0.0.0:5433-\\u003e5432/tcp, [::]:5433-\\u003e5432/tcp","RunningFor":"2 days ago","Size":"20.5kB (virtual 313MB)","State":"running","Status":"Up 10 hours (healthy)"}'

/** `docker inspect <c> --format '{{.State.Status}}'` on this repo's dev Postgres. */
const DEV_PG_STOPPED = 'exited'
const DEV_PG_RUNNING = 'running'

describe('classifyDevDb', () => {
  it('reports reachable when the container is attached and the port answers', () => {
    expect(
      classifyDevDb({
        containerStatus: DEV_PG_RUNNING,
        containerAttached: true,
        hostPortAnswers: true,
        owner: null,
      }),
    ).toEqual({ kind: 'reachable' })
  })

  it('reports unreachable when the container is attached but nothing answers the port', () => {
    expect(
      classifyDevDb({
        containerStatus: DEV_PG_RUNNING,
        containerAttached: true,
        hostPortAnswers: false,
        owner: null,
      }),
    ).toEqual({ kind: 'unreachable' })
  })

  it('does not claim reachable without the host confirming the port', () => {
    // `up -d --wait` waits on an in-container health check, so health is not
    // evidence that a host process can connect.
    expect(
      classifyDevDb({
        containerStatus: DEV_PG_RUNNING,
        containerAttached: true,
        hostPortAnswers: false,
        owner: null,
      }).kind,
    ).not.toBe('reachable')
  })

  it('reports not-running when the container is absent or exited, whatever holds the port', () => {
    // The two are the same state to a host process: nothing of ours is serving.
    expect(
      classifyDevDb({
        containerStatus: DEV_PG_STOPPED,
        containerAttached: false,
        hostPortAnswers: false,
        owner: null,
      }),
    ).toEqual({ kind: 'not-running' })
    expect(
      classifyDevDb({
        containerStatus: null,
        containerAttached: false,
        hostPortAnswers: false,
        owner: null,
      }),
    ).toEqual({ kind: 'not-running' })
  })

  it('reports container-not-attached when running but Docker never wired the network', () => {
    // The machine state that produced "database vod_dev does not exist": Compose
    // said Healthy, `docker port` was empty, and the host port belonged to
    // another project. `up -d --wait` exits 0 in this state.
    expect(
      classifyDevDb({
        containerStatus: DEV_PG_RUNNING,
        containerAttached: false,
        hostPortAnswers: true,
        owner: { name: 'docento-postgres-1', project: 'docento', service: 'postgres' },
      }),
    ).toEqual({
      kind: 'container-not-attached',
      owner: { name: 'docento-postgres-1', project: 'docento', service: 'postgres' },
    })
  })

  it('reports port-held-elsewhere when another server answers with our container stopped', () => {
    expect(
      classifyDevDb({
        containerStatus: DEV_PG_STOPPED,
        containerAttached: false,
        hostPortAnswers: true,
        owner: { name: 'docento-postgres-1', project: 'docento', service: 'postgres' },
      }),
    ).toEqual({
      kind: 'port-held-elsewhere',
      owner: { name: 'docento-postgres-1', project: 'docento', service: 'postgres' },
    })
  })

  it('names no owner when something answers the port but Docker does not know what', () => {
    expect(
      classifyDevDb({
        containerStatus: DEV_PG_STOPPED,
        containerAttached: false,
        hostPortAnswers: true,
        owner: null,
      }),
    ).toEqual({ kind: 'port-held-elsewhere', owner: null })
  })
})

describe('parsePortOwners', () => {
  it('reads the Compose labels out of `docker ps --format {{json .}}`', () => {
    expect(parsePortOwners(`${DOCENTO_PS_LINE}\n`)).toEqual([
      { name: 'docento-postgres-1', project: 'docento', service: 'postgres' },
    ])
  })

  it('returns nothing for empty output', () => {
    expect(parsePortOwners('')).toEqual([])
    expect(parsePortOwners('\n  \n')).toEqual([])
  })

  it('keeps the container name when the labels are absent (a plain `docker run`)', () => {
    expect(parsePortOwners('{"Names":"some-postgres","State":"running"}')).toEqual([
      { name: 'some-postgres', project: null, service: null },
    ])
  })

  it('drops lines that are not JSON rather than throwing', () => {
    expect(parsePortOwners('not json\n{"Names":"pg"}')).toEqual([
      { name: 'pg', project: null, service: null },
    ])
  })

  it('ignores a stopped container even when it still holds the binding', () => {
    expect(
      parsePortOwners('{"Names":"stale-pg","State":"exited","Labels":""}'),
    ).toEqual([])
  })

  it('reads several owners, one per line', () => {
    expect(
      parsePortOwners(
        '{"Names":"a","State":"running","Labels":"com.docker.compose.project=p1"}\n' +
          '{"Names":"b","State":"running","Labels":""}',
      ),
    ).toEqual([
      { name: 'a', project: 'p1', service: null },
      { name: 'b', project: null, service: null },
    ])
  })
})

describe('remediationFor', () => {
  it('names the owning container and project for a foreign port', () => {
    const lines = remediationFor({
      kind: 'port-held-elsewhere',
      owner: { name: 'docento-postgres-1', project: 'docento', service: 'postgres' },
    })
    expect(lines.join('\n')).toContain('docento-postgres-1')
    expect(lines.join('\n')).toContain('project "docento"')
  })

  it('tells the user to recreate an unattached container', () => {
    const lines = remediationFor({
      kind: 'container-not-attached',
      owner: { name: 'docento-postgres-1', project: 'docento', service: 'postgres' },
    }).join('\n')
    expect(lines).toContain('docker compose -f docker-compose.dev.yml rm -sf postgres')
    expect(lines).toContain('docento-postgres-1')
  })

  it('points at `pnpm dev:infra` when nothing is running', () => {
    expect(remediationFor({ kind: 'not-running' }).join('\n')).toContain('pnpm dev:infra')
  })

  it('sends the user to the container logs when it is up but silent', () => {
    const lines = remediationFor({ kind: 'unreachable' }).join('\n')
    expect(lines).toContain('docker compose -f docker-compose.dev.yml logs')
    expect(lines).toContain('pnpm dev:infra')
  })

  it('offers no remediation when the database is already reachable', () => {
    expect(remediationFor({ kind: 'reachable' })).toEqual([])
  })
})

describe('quickFixFor', () => {
  it('gives one command for a single-line verification row', () => {
    expect(quickFixFor({ kind: 'not-running' })).toBe('run: pnpm dev:infra && pnpm db:migrate')
  })

  it('is undefined when there is nothing to fix', () => {
    expect(quickFixFor({ kind: 'reachable' })).toBeUndefined()
  })
})

describe('portAllocatedMessage', () => {
  it('matches the daemon error that leaves a container created but unattached', () => {
    const stderr =
      'Error response from daemon: failed to set up container networking: driver failed ' +
      'programming external connectivity on endpoint clipmux-dev-postgres (5cee23f9): ' +
      'Bind for :::5433 failed: port is already allocated'
    expect(portAllocatedMessage(stderr)).toBe(true)
  })

  it('does not fire on unrelated compose failures', () => {
    expect(portAllocatedMessage('no configuration file provided')).toBe(false)
  })
})

describe('missingComposeFileMessage', () => {
  it('explains a wrong working directory instead of leaking Compose jargon', () => {
    expect(missingComposeFileMessage('/home/vishesh/vod', false)).toContain(
      'no docker-compose.dev.yml in /home/vishesh/vod',
    )
  })

  it('is undefined when the file is there', () => {
    expect(missingComposeFileMessage('/home/vishesh/vod', true)).toBeUndefined()
  })
})

describe('devInfraChoice', () => {  it('is true for the dev target with the local Postgres on the Node runtime', () => {
    expect(devInfraChoice(answers())).toBe(true)
  })

  it('is false for the deploy target — that stack has its own Compose database', () => {
    expect(devInfraChoice(answers({ target: 'deploy' }))).toBe(false)
  })

  it('is false for an existing server — there is nothing to start', () => {
    expect(devInfraChoice(answers({ db: { kind: 'existing', url: 'postgresql://x/y' } }))).toBe(
      false,
    )
  })
})
