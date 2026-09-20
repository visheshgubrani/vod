import { describe, expect, it } from 'vitest'
import {
  conflictMessage,
  containersPublishingPort,
  findPortConflicts,
  hostInstallPorts,
  isOurContainer,
  type HostPortNeed,
} from '../src/ports'
import { dockerArgv, dockerCmd } from '../src/dockerCli'

describe('dockerArgv', () => {
  it('defaults to docker and honours CLIPMUX_DOCKER', () => {
    const previous = process.env.CLIPMUX_DOCKER
    delete process.env.CLIPMUX_DOCKER
    expect(dockerArgv()).toEqual(['docker'])
    expect(dockerCmd('compose', 'ps')).toEqual(['docker', 'compose', 'ps'])
    process.env.CLIPMUX_DOCKER = 'sudo -n docker'
    expect(dockerArgv()).toEqual(['sudo', '-n', 'docker'])
    expect(dockerCmd('info')).toEqual(['sudo', '-n', 'docker', 'info'])
    if (previous === undefined) delete process.env.CLIPMUX_DOCKER
    else process.env.CLIPMUX_DOCKER = previous
  })
})

describe('host port conflicts', () => {
  const http: HostPortNeed = { port: 80, bind: '127.0.0.1', role: 'Caddy HTTP' }

  it('treats clipmux containers as this installation', () => {
    expect(isOurContainer('clipmux-caddy')).toBe(true)
    expect(isOurContainer('clipmux-api')).toBe(true)
    expect(isOurContainer('nginx')).toBe(false)
    expect(isOurContainer('coolify-proxy')).toBe(false)
  })

  it('parses docker ps published ports', () => {
    const ps = [
      'clipmux-caddy\t127.0.0.1:80->80/tcp, 127.0.0.1:443->443/tcp',
      'unrelated\t0.0.0.0:8080->80/tcp',
    ].join('\n')
    expect(containersPublishingPort(ps, 80).map((owner) => owner.name)).toEqual([
      'clipmux-caddy',
    ])
    expect(containersPublishingPort(ps, 443)[0]?.ours).toBe(true)
  })

  it('ignores this installation’s running containers', async () => {
    const conflicts = await findPortConflicts([http], async () => ({
      dockerPs: 'clipmux-caddy\t127.0.0.1:80->80/tcp',
      listening: new Set([80]),
    }))
    expect(conflicts).toEqual([])
  })

  it('reports an unrelated container by name', async () => {
    const conflicts = await findPortConflicts([http], async () => ({
      dockerPs: 'nginx\t0.0.0.0:80->80/tcp',
      listening: new Set([80]),
    }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].owner?.name).toBe('nginx')
    expect(conflictMessage(conflicts[0])).toContain('nginx')
    expect(conflictMessage(conflicts[0])).toContain('not this ClipMux installation')
  })

  it('reports an unrelated host listener when Docker does not own the port', async () => {
    const conflicts = await findPortConflicts([http], async () => ({
      dockerPs: '',
      listening: new Set([80]),
    }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].owner).toBeNull()
    expect(conflictMessage(conflicts[0])).toContain('already in use')
  })

  it('requires 80 for localhost and 80+443 for a public hostname', () => {
    expect(hostInstallPorts('127.0.0.1', 'localhost').map((need) => need.port)).toEqual([80])
    expect(hostInstallPorts('0.0.0.0', 'domain').map((need) => need.port)).toEqual([80, 443])
  })
})
