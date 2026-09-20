/**
 * Host-port checks for a host install.
 *
 * A busy port is only a conflict when it is not this installation's own
 * container. Reruns keep the ClipMux containers; an unrelated listener is
 * what must stop the installer, with a name the operator can act on.
 */

import { dockerCmd } from './dockerCli'
import { runCapture } from './runners'

export interface HostPortNeed {
  port: number
  bind: string
  role: string
}

export interface PortOwner {
  name: string
  ours: boolean
}

export interface PortConflict {
  need: HostPortNeed
  owner: PortOwner | null
}

const OURS = /^(clipmux[-_]|clipmux$)/i

export function isOurContainer(name: string): boolean {
  return OURS.test(name.trim())
}

/** Parse `docker ps --format '{{.Names}}\t{{.Ports}}'` into listeners per port. */
export function containersPublishingPort(
  dockerPs: string,
  port: number,
): PortOwner[] {
  const owners: PortOwner[] = []
  for (const line of dockerPs.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const tab = trimmed.indexOf('\t')
    const name = tab === -1 ? trimmed : trimmed.slice(0, tab).trim()
    const ports = tab === -1 ? '' : trimmed.slice(tab + 1)
    if (!ports.includes(`:${port}->`)) continue
    if (name === '') continue
    owners.push({ name, ours: isOurContainer(name) })
  }
  return owners
}

export function conflictMessage(conflict: PortConflict): string {
  const { need, owner } = conflict
  const where = `${need.bind}:${need.port}`
  if (owner === null) {
    return (
      `port ${where} (${need.role}) is already in use. ` +
      `Stop the other listener, then re-run. Port overrides are not supported yet.`
    )
  }
  return (
    `port ${where} (${need.role}) is held by ${owner.name}, which is not this ClipMux installation. ` +
    `Stop that container or process, then re-run.`
  )
}

export async function findPortConflicts(
  needs: readonly HostPortNeed[],
  inspect: () => Promise<{ dockerPs: string; listening: ReadonlySet<number> }>,
): Promise<PortConflict[]> {
  const { dockerPs, listening } = await inspect()
  const conflicts: PortConflict[] = []
  for (const need of needs) {
    const owners = containersPublishingPort(dockerPs, need.port)
    if (owners.some((owner) => owner.ours)) continue
    if (owners.length > 0) {
      conflicts.push({ need, owner: owners[0] })
      continue
    }
    if (listening.has(need.port)) {
      conflicts.push({ need, owner: null })
    }
  }
  return conflicts
}

/** Ports a host install must own, given the proxy bind address. */
export function hostInstallPorts(bindAddress: string, access: 'localhost' | 'domain'): HostPortNeed[] {
  const bind = bindAddress.trim() || (access === 'localhost' ? '127.0.0.1' : '0.0.0.0')
  const ports: HostPortNeed[] = [{ port: 80, bind, role: 'Caddy HTTP' }]
  if (access === 'domain') {
    ports.push({ port: 443, bind, role: 'Caddy HTTPS' })
  }
  return ports
}

function listeningPortsFromProc(ipv4: string, ipv6: string): Set<number> {
  const ports = new Set<number>()
  const parse = (text: string, hex: boolean): void => {
    for (const line of text.split(/\r?\n/).slice(1)) {
      const cols = line.trim().split(/\s+/)
      const local = cols[1]
      if (!local) continue
      const colon = local.lastIndexOf(':')
      if (colon === -1) continue
      const raw = local.slice(colon + 1)
      const port = hex ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10)
      if (Number.isFinite(port) && port > 0) ports.add(port)
    }
  }
  parse(ipv4, true)
  parse(ipv6, true)
  return ports
}

export async function inspectHostListeners(
  readFile: (path: string) => string,
  dockerPs: () => Promise<string>,
): Promise<{ dockerPs: string; listening: ReadonlySet<number> }> {
  let ipv4 = ''
  let ipv6 = ''
  try {
    ipv4 = readFile('/proc/net/tcp')
  } catch {
    ipv4 = ''
  }
  try {
    ipv6 = readFile('/proc/net/tcp6')
  } catch {
    ipv6 = ''
  }
  return { dockerPs: await dockerPs(), listening: listeningPortsFromProc(ipv4, ipv6) }
}

export async function checkHostPorts(needs: readonly HostPortNeed[]): Promise<void> {
  const { readFileSync } = await import('node:fs')
  const inspect = async () =>
    inspectHostListeners(
      (path) => readFileSync(path, 'utf8'),
      async () => {
        const result = await runCapture(dockerCmd('ps', '--format', '{{.Names}}\t{{.Ports}}'), {
          timeoutMs: 20_000,
        })
        return result.stdout
      },
    )
  const conflicts = await findPortConflicts(needs, inspect)
  if (conflicts.length === 0) return
  throw new Error(conflicts.map(conflictMessage).join('\n'))
}
