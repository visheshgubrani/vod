/**
 * Probing: what this machine actually has.
 *
 * Every probe is read-only, short-lived and tolerant: a missing binary, a
 * stopped daemon or a refused socket is a *finding*, never an exception. The
 * interesting cases are the ones where a binary exists and still cannot do the
 * job — Docker installed but the daemon unreachable for this user is the
 * classic, and reporting it as "Docker ✓" is how someone ends up debugging a
 * stack they were told was ready.
 */

import { connect } from 'node:net'
import { findOnPath, runCapture } from './runners'
import type { RequirementStatus, Requirement } from './system'

export interface ToolProbe {
  found: boolean
  detail?: string
}

const VERSION_FLAGS: Record<string, string[]> = {
  curl: ['--version'],
  git: ['--version'],
  node: ['--version'],
  python3: ['--version'],
  uv: ['--version'],
  ffmpeg: ['-version'],
}

/** First line of a version command, trimmed; '' when there is nothing useful. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim() !== '') ?? ''
  return line.trim().slice(0, 80)
}

async function probeVersion(bin: string, args: string[], timeoutMs = 15_000): Promise<ToolProbe> {
  const result = await runCapture([bin, ...args], { timeoutMs })
  if (result.code !== 0) {
    return { found: false, detail: firstLine(result.stderr) || 'did not run' }
  }
  return { found: true, ...(firstLine(result.stdout) !== '' ? { detail: firstLine(result.stdout) } : {}) }
}

/** Docker is two findings: the CLI/daemon, and the Compose v2 plugin. */
export async function probeDocker(): Promise<ToolProbe> {
  const bin = findOnPath('docker')
  if (bin === null) return { found: false, detail: 'not installed' }
  const version = await probeVersion(bin, ['--version'])
  if (!version.found) return version

  const info = await runCapture([bin, 'info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: 20_000,
  })
  if (info.code !== 0) {
    const output = `${info.stdout}\n${info.stderr}`.toLowerCase()
    if (output.includes('permission denied')) {
      return {
        found: false,
        detail: 'installed, but this user cannot reach the daemon (add yourself to the `docker` group)',
      }
    }
    if (info.timedOut) return { found: false, detail: 'installed, but the daemon did not answer' }
    return { found: false, detail: 'installed, but the daemon is not running' }
  }
  return { found: true, detail: version.detail }
}

export async function probeDockerCompose(): Promise<ToolProbe> {
  const bin = findOnPath('docker')
  if (bin === null) return { found: false, detail: 'docker is not installed' }
  const result = await runCapture([bin, 'compose', 'version'], { timeoutMs: 20_000 })
  if (result.code !== 0) {
    return { found: false, detail: 'the `docker compose` v2 plugin is missing' }
  }
  return { found: true, detail: firstLine(result.stdout) }
}

/** `python3 -m venv` — the capability, not just the interpreter. */
export async function probePythonVenv(): Promise<ToolProbe> {
  const bin = findOnPath('python3')
  if (bin === null) return { found: false, detail: 'not installed' }
  const version = await probeVersion(bin, ['--version'])
  if (!version.found) return version
  const venv = await runCapture([bin, '-m', 'venv', '--help'], { timeoutMs: 20_000 })
  if (venv.code !== 0) {
    return {
      found: false,
      detail: `${version.detail} — but \`python3 -m venv\` is unavailable (install the python3-venv package, or use uv)`,
    }
  }
  return { found: true, detail: version.detail }
}

async function probeOne(requirement: Requirement): Promise<RequirementStatus> {
  switch (requirement.id) {
    case 'docker':
      return { requirement, ...(await probeDocker()) }
    case 'docker-compose':
      return { requirement, ...(await probeDockerCompose()) }
    case 'python3':
      return { requirement, ...(await probePythonVenv()) }
    case 'uv': {
      const bin = findOnPath('uv')
      if (bin === null) return { requirement, found: false, detail: 'not installed' }
      return { requirement, ...(await probeVersion(bin, VERSION_FLAGS['uv'] ?? ['--version'])) }
    }
    default: {
      const bin = findOnPath(requirement.id)
      if (bin === null) return { requirement, found: false, detail: 'not installed' }
      return {
        requirement,
        ...(await probeVersion(bin, VERSION_FLAGS[requirement.id] ?? ['--version'])),
      }
    }
  }
}

/** Probe every requirement, in order. */
export async function probeRequirements(
  requirements: readonly Requirement[],
): Promise<RequirementStatus[]> {
  const statuses: RequirementStatus[] = []
  for (const requirement of requirements) {
    statuses.push(await probeOne(requirement))
  }
  return statuses
}

export interface HostPort {
  host: string
  port: number
}

/**
 * host:port for a connection URL.
 *
 * Pure, and deliberately tolerant: a URL the wizard cannot parse is not an
 * error, it just means "no reachability probe" — the value is still written and
 * the API reports the real problem when it starts.
 */
export function hostPortFromUrl(url: string, defaultPort: number): HostPort | undefined {
  const trimmed = (url ?? '').trim()
  if (trimmed === '') return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname === '') return undefined
    return {
      host: parsed.hostname,
      port: parsed.port === '' ? defaultPort : Number.parseInt(parsed.port, 10),
    }
  } catch {
    return undefined
  }
}

/** TCP reachability, used as an advisory check for Postgres/Redis URLs. */
export async function probeTcp(
  url: string,
  defaultPort: number,
  timeoutMs = 5_000,
): Promise<ToolProbe> {
  const target = hostPortFromUrl(url, defaultPort)
  if (target === undefined) return { found: false, detail: 'could not parse the URL' }
  return await new Promise<ToolProbe>((resolve) => {
    const socket = connect({ host: target.host, port: target.port })
    const finish = (result: ToolProbe): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ found: true, detail: `${target.host}:${target.port}` }))
    socket.once('timeout', () =>
      finish({ found: false, detail: `${target.host}:${target.port} did not answer` }),
    )
    socket.once('error', (error: Error) =>
      finish({ found: false, detail: `${target.host}:${target.port} — ${error.message}` }),
    )
  })
}
