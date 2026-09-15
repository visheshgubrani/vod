/**
 * Is the dev Postgres actually usable from this machine?
 *
 * `pnpm dev:infra` creates the containers, but "created" and "reachable" are
 * not the same thing: when host port 5433 is already taken by another Compose
 * project, Docker creates `clipmux-dev-postgres`, fails to programme the port
 * mapping, and leaves it running *without a network endpoint*. Compose then
 * exits 0 and reports the container as healthy (the health check runs inside
 * the container's own namespace), so every signal a script has says "up" —
 * while `DATABASE_URL` points at whatever else owns the port. The API's first
 * real query is what finally fails, with `database "vod_dev" does not exist`.
 *
 * The decisions here are pure so they can be tested against the exact states
 * that machine produced; the probing and the starting are thin wrappers over
 * `runners.ts` / `probe.ts`.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEV_LOCAL_DATABASE_URL } from './mapping'
import { hostPortFromUrl, probeTcp } from './probe'
import { runCapture, runInherit } from './runners'
import type { WizardAnswers } from './types'

export const DEV_COMPOSE_FILE = 'docker-compose.dev.yml'
export const DEV_COMPOSE_PROJECT = 'clipmux-dev'
export const DEV_PG_SERVICE = 'postgres'
export const DEV_PG_CONTAINER = 'clipmux-dev-postgres'
export const DEV_PG_PORT = 5433
export const DEV_REDIS_PORT = 6382

/** The dev Redis `docker-compose.dev.yml` publishes, for the remediation text. */
export const DEV_REDIS_URL = `redis://localhost:${DEV_REDIS_PORT}`

export interface PortOwner {
  name: string
  /** Compose project and service, when this container came from Compose. */
  project: string | null
  service: string | null
}

/**
 * What the dev Postgres looks like to a host-side process.
 *
 * `container-not-attached` is the failure this module exists for: the container
 * reports healthy and cannot be reached.
 */
export type DevDbVerdict =
  /** Ours is serving the port and a host process can reach it. */
  | { kind: 'reachable' }
  /** Nothing of ours is serving: the container is absent, exited, or stopped. */
  | { kind: 'not-running' }
  /** Attached and started, but no host process can connect — never "reachable". */
  | { kind: 'unreachable' }
  | { kind: 'container-not-attached'; owner: PortOwner | null }
  | { kind: 'port-held-elsewhere'; owner: PortOwner | null }

export interface DevInfraStatus {
  /** `docker inspect` on the dev container, or null when it does not exist. */
  container: {
    status: string | null
    /** False when Docker never wired an endpoint (`.NetworkSettings.Networks` empty). */
    attached: boolean
  }
  /** Everything answering on the dev Postgres port, as Docker knows it. */
  owners: PortOwner[]
  /** Does a socket on the dev Postgres port accept a connection? */
  hostPortAnswers: boolean
  verdict: DevDbVerdict
}

/**
 * The verdict, from the four observable facts.
 *
 * Order is the whole decision: a running container that Docker did not attach
 * stays unexplained by the port alone, so it is reported as such rather than as
 * "someone else has the port".
 */
export function classifyDevDb(input: {
  containerStatus: string | null
  containerAttached: boolean
  hostPortAnswers: boolean
  owner: PortOwner | null
}): DevDbVerdict {
  const running = input.containerStatus === 'running'
  if (running && !input.containerAttached) {
    return { kind: 'container-not-attached', owner: input.owner }
  }
  if (input.hostPortAnswers) {
    // A running, attached container that answers the port is the only shape where
    // "reachable" is earned. Anything else answering means a foreign server took
    // the port before ours could.
    return running ? { kind: 'reachable' } : { kind: 'port-held-elsewhere', owner: input.owner }
  }
  return running ? { kind: 'unreachable' } : { kind: 'not-running' }
}

/** Is starting the dev containers the right next step for these answers? */
export function devInfraChoice(answers: WizardAnswers): boolean {
  return (
    (answers.target ?? 'dev') === 'dev' &&
    answers.runtime === 'node' &&
    answers.db.kind === 'local'
  )
}

/** One line naming who owns a port, for a warning. */
function describePortOwner(owner: PortOwner): string {
  return owner.project === null
    ? `container "${owner.name}"`
    : `container "${owner.name}" (project "${owner.project}")`
}

/** The commands that fix a verdict. Empty when there is nothing to fix. */
export function remediationFor(verdict: DevDbVerdict): string[] {
  const recreate = `docker compose -f ${DEV_COMPOSE_FILE} rm -sf ${DEV_PG_SERVICE}`
  switch (verdict.kind) {
    case 'reachable':
      return []
    case 'not-running':
      return [
        'start it:  pnpm dev:infra',
        `if it stays down, recreate it:  ${recreate} && pnpm dev:infra`,
        'then apply migrations:  pnpm db:migrate',
      ]
    case 'unreachable':
      return [
        `${DEV_PG_CONTAINER} is running but nothing answers port ${DEV_PG_PORT} — ` +
          'check its logs and restart it:',
        `  docker compose -f ${DEV_COMPOSE_FILE} logs --tail 50 ${DEV_PG_SERVICE}`,
        `  ${recreate} && pnpm dev:infra`,
        'then apply migrations:  pnpm db:migrate',
      ]
    case 'port-held-elsewhere': {
      const who =
        verdict.owner === null
          ? `something outside Docker already answers port ${DEV_PG_PORT}`
          : `${describePortOwner(verdict.owner)} already answers port ${DEV_PG_PORT}`
      return [
        `${who} — it is not this workspace's dev Postgres`,
        'stop that container (or the other project), then:  pnpm dev:infra',
        `if Docker created ours first, recreate it so the port binds:  ${recreate} && pnpm dev:infra`,
        'then apply migrations:  pnpm db:migrate',
      ]
    }
    case 'container-not-attached': {
      const blocked =
        verdict.owner === null
          ? `Docker could not attach ${DEV_PG_CONTAINER}'s network/port mapping`
          : `Docker could not attach ${DEV_PG_CONTAINER}'s network/port mapping — port ${DEV_PG_PORT} is held by ${describePortOwner(verdict.owner)}`
      return [
        `${blocked}. The container can report healthy while being unreachable, so ` +
          'the port must be free before it is recreated.',
        `recreate it:  ${recreate} && pnpm dev:infra`,
        'then apply migrations:  pnpm db:migrate',
      ]
    }
  }
}

/** The one command that fixes a verdict, for a single-line row. */
export function quickFixFor(verdict: DevDbVerdict): string | undefined {
  switch (verdict.kind) {
    case 'reachable':
      return undefined
    case 'not-running':
      return 'run: pnpm dev:infra && pnpm db:migrate'
    case 'unreachable':
      return 'check: docker compose -f docker-compose.dev.yml logs postgres'
    case 'port-held-elsewhere':
    case 'container-not-attached':
      return `recreate it: docker compose -f ${DEV_COMPOSE_FILE} rm -sf ${DEV_PG_SERVICE} && pnpm dev:infra`
  }
}

/** The daemon error that leaves a container created but unattached. */
export function portAllocatedMessage(stderr: string): boolean {
  return /port is already allocated/i.test(stderr)
}

/* ── I/O ──────────────────────────────────────────────────────────────────── */

/** One container's name and Compose labels, from `docker ps`/`inspect`. */
function parseOwnerRecord(name: string | undefined, labels: string | undefined): PortOwner | null {
  const trimmed = (name ?? '').trim()
  if (trimmed === '') return null
  const values = new Map<string, string>()
  for (const pair of (labels ?? '').split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    values.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  return {
    name: trimmed,
    project: values.get('com.docker.compose.project') ?? null,
    service: values.get('com.docker.compose.service') ?? null,
  }
}

/**
 * Every container publishing `port`, from `docker ps --format {{json .}}`.
 *
 * Strict about the format on purpose: `docker ps` prints one JSON object per
 * line, so anything else is noise (a warning on stderr that leaked into stdout,
 * a truncated line) and is dropped rather than mistaken for a container name.
 */
export function parsePortOwners(stdout: string): PortOwner[] {
  const owners: PortOwner[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('{')) continue
    try {
      const record = JSON.parse(line) as { Names?: string; Labels?: string; State?: string }
      if (record.State !== undefined && record.State !== 'running') continue
      const owner = parseOwnerRecord(record.Names, record.Labels)
      if (owner !== null) owners.push(owner)
    } catch {
      // A line that does not parse is not a container.
    }
  }
  return owners
}

function containerFromInspect(stdout: string): { status: string | null; attached: boolean } | null {
  const [status = '', networks = '{}'] = stdout.split('\n')
  const state = status.trim()
  if (state === '' || state === '<no value>') return null
  let attached = false
  try {
    attached = Object.keys(JSON.parse(networks) as Record<string, unknown>).length > 0
  } catch {
    // Unparseable network info is treated as "not attached": reporting a
    // container as reachable on a guess is the failure this module prevents.
    attached = false
  }
  return { status: state, attached }
}

async function inspectDevContainer(root: string): Promise<DevInfraStatus['container'] | null> {
  const result = await runCapture([
    'docker',
    'inspect',
    DEV_PG_CONTAINER,
    '--format',
    '{{.State.Status}}\n{{json .NetworkSettings.Networks}}',
  ], { cwd: root, timeoutMs: 20_000 })
  if (result.code !== 0) return null
  return containerFromInspect(result.stdout)
}

async function portOwners(root: string, port: number): Promise<PortOwner[]> {
  const result = await runCapture(
    ['docker', 'ps', '--filter', `publish=${port}`, '--format', '{{json .}}'],
    { cwd: root, timeoutMs: 20_000 },
  )
  // A failed `docker ps` means "Docker could not tell us", never "nothing is
  // there" — the caller still has the host-port answer to go on.
  if (result.code !== 0) return []
  return parsePortOwners(result.stdout)
}

/** Observe the dev Postgres: container state, port owners, host reachability. */
export async function inspectDevInfra(
  root: string,
  databaseUrl: string = DEV_LOCAL_DATABASE_URL,
): Promise<DevInfraStatus> {
  const port = hostPortFromUrl(databaseUrl, 5432)?.port ?? DEV_PG_PORT
  const [container, owners, reachable] = await Promise.all([
    inspectDevContainer(root),
    portOwners(root, port),
    probeTcp(databaseUrl, 5432),
  ])
  const status = container ?? { status: null, attached: false }
  const hostPortAnswers = reachable.found
  const owner =
    owners.find((candidate) => candidate.name !== DEV_PG_CONTAINER) ?? owners[0] ?? null
  return {
    container: status,
    owners,
    hostPortAnswers,
    verdict: classifyDevDb({
      containerStatus: status.status,
      containerAttached: status.attached,
      hostPortAnswers,
      owner,
    }),
  }
}

export interface StartDevInfraResult {
  ok: boolean
  /** True when the failure is the port allocation the user has to clear. */
  portAllocated: boolean
  output: string
}

/**
 * A missing compose file must not look like a container problem — Compose's own
 * message for it ("no configuration file provided") reads like a Docker fault.
 */
export function missingComposeFileMessage(root: string, exists: boolean): string | undefined {
  return exists ? undefined : `no ${DEV_COMPOSE_FILE} in ${root} — is this the repo root?`
}

/**
 * `pnpm dev:infra`: start Postgres + Redis and wait for their health checks.
 *
 * The compose file is named by absolute path: `docker compose -f` resolves a
 * relative one against the *current* directory, not the root, so a run from
 * anywhere else would silently find nothing to start.
 */
export async function startDevInfra(root: string): Promise<StartDevInfraResult> {
  const composeFile = join(root, DEV_COMPOSE_FILE)
  const missing = missingComposeFileMessage(root, existsSync(composeFile))
  if (missing !== undefined) {
    return { ok: false, portAllocated: false, output: missing }
  }
  const result = await runCapture(
    ['docker', 'compose', '-f', composeFile, 'up', '-d', '--wait'],
    { cwd: root, timeoutMs: 300_000 },
  )
  const output = `${result.stdout}${result.stderr}`.trim()
  return { ok: result.code === 0, portAllocated: portAllocatedMessage(output), output }
}

/** `pnpm db:migrate` — the dev target's migration path, streamed to the user. */
export async function migrateDevDb(root: string): Promise<boolean> {
  const code = await runInherit(['pnpm', 'db:migrate'], { cwd: root })
  return code === 0
}
