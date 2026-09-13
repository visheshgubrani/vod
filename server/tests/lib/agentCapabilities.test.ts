import { describe, expect, it } from 'vitest'
import {
  AGENT_LIVENESS_WINDOW_MS,
  buildAgentHealth,
  buildPublicCapabilities,
  isAgentLive,
  preferredEncoder,
  validateCapabilities,
  type AgentRow,
} from '../../src/lib/agentCapabilities'

const NOW = Date.parse('2026-03-01T12:00:00Z')

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'agt_1',
    name: 'Studio Mac',
    enabled: true,
    lastSeenAt: new Date(NOW - 5_000),
    capabilities: { encoders: ['nvenc', 'cpu'], transcription: true },
    hostname: 'studio.local',
    agentVersion: '1.0.0',
    capacityJobs: 2,
    capacityRenditions: 1,
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    modalWebhookUrl: 'https://modal.example.com/transcode',
    ingestSecret: 'secret',
    rawBucket: 'openvod-raw',
    transcodedBucket: 'openvod-transcoded',
    hasStorageCredentials: true,
    agents: [agent()],
    defaultProvider: 'modal',
    selfHostedEnabled: true,
    aiEnabled: false,
    now: NOW,
    ...overrides,
  } as Parameters<typeof buildPublicCapabilities>[0]
}

describe('isAgentLive', () => {
  it('counts a recent heartbeat as online', () => {
    expect(isAgentLive(new Date(NOW - 5_000), NOW)).toBe(true)
  })

  it('treats an agent that missed three intervals as offline', () => {
    expect(isAgentLive(new Date(NOW - AGENT_LIVENESS_WINDOW_MS - 1), NOW)).toBe(false)
  })

  it('treats an agent that has never been seen as offline', () => {
    expect(isAgentLive(null, NOW)).toBe(false)
  })
})

describe('buildPublicCapabilities', () => {
  it('reports both providers when Modal and an online agent are configured', () => {
    const caps = buildPublicCapabilities(input())
    expect(caps.providers).toEqual(['modal', 'self-hosted'])
    expect(caps.uploads).toBe(true)
    expect(caps.localImport).toBe(true)
  })

  it('reports local import available with no Modal configuration at all', () => {
    // The v1 commitment: a mounted file reaches playback with no raw bucket and
    // no Modal account.
    const caps = buildPublicCapabilities(
      input({ modalWebhookUrl: null, ingestSecret: null, rawBucket: null }),
    )
    expect(caps.providers).toEqual(['self-hosted'])
    expect(caps.localImport).toBe(true)
    expect(caps.uploads).toBe(false)
  })

  it('withdraws local import when no agent has been seen recently', () => {
    const caps = buildPublicCapabilities(
      input({ agents: [agent({ lastSeenAt: new Date(NOW - 600_000) })] }),
    )
    expect(caps.localImport).toBe(false)
    expect(caps.providers).toEqual(['modal'])
  })

  it('withdraws local import for a disabled agent', () => {
    const caps = buildPublicCapabilities(input({ agents: [agent({ enabled: false })] }))
    expect(caps.localImport).toBe(false)
  })

  it('exposes only counts, never agent names or hostnames', () => {
    const caps = buildPublicCapabilities(input())
    expect(caps.agents).toEqual({ paired: 1, online: 1 })
    expect(JSON.stringify(caps)).not.toContain('studio.local')
    expect(JSON.stringify(caps)).not.toContain('Studio Mac')
  })

  it('falls back to an available provider when the configured default is not one', () => {
    const caps = buildPublicCapabilities(
      input({ defaultProvider: 'self-hosted', agents: [] }),
    )
    expect(caps.defaultProvider).toBe('modal')
  })

  it('keeps the configured default when it is available', () => {
    const caps = buildPublicCapabilities(input({ defaultProvider: 'self-hosted' }))
    expect(caps.defaultProvider).toBe('self-hosted')
  })

  it('reports enrichment from the agent when the API has no AI provider', () => {
    const caps = buildPublicCapabilities(input({ aiEnabled: false }))
    expect(caps.subtitles).toBe(true)
    expect(caps.chapters).toBe(false)
  })

  it('never advertises a provider that is switched off', () => {
    const caps = buildPublicCapabilities(input({ selfHostedEnabled: false }))
    expect(caps.providers).toEqual(['modal'])
    expect(caps.localImport).toBe(false)
  })
})

describe('buildAgentHealth', () => {
  it('reports connectivity and capacity per agent', () => {
    const [health] = buildAgentHealth([agent()], NOW)
    expect(health).toMatchObject({
      id: 'agt_1',
      name: 'Studio Mac',
      online: true,
      hostname: 'studio.local',
      capacityJobs: 2,
      capacityRenditions: 1,
      encoders: ['nvenc', 'cpu'],
    })
    expect(health.lastSeenAt).toBe(new Date(NOW - 5_000).toISOString())
  })

  it('carries no filesystem paths', () => {
    const health = buildAgentHealth(
      [agent({ capabilities: { encoders: ['cpu'], scratchFreeBytes: 42 } })],
      NOW,
    )
    expect(JSON.stringify(health)).not.toContain('/media')
    expect(health[0].scratchFreeBytes).toBe(42)
  })

  it('survives an agent whose capabilities never arrived', () => {
    const [health] = buildAgentHealth([agent({ capabilities: null })], NOW)
    expect(health.encoders).toEqual([])
    expect(health.probedAt).toBeNull()
  })
})

describe('validateCapabilities', () => {
  it('accepts an empty report', () => {
    expect(validateCapabilities(undefined)).toEqual({ ok: true, value: {} })
    expect(validateCapabilities(null)).toEqual({ ok: true, value: {} })
  })

  it('accepts a well-formed report', () => {
    const result = validateCapabilities({
      encoders: ['cpu', 'vaapi'],
      cpuCores: 16,
      transcription: false,
      ffmpeg: 'ffmpeg version 6.1',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.encoders).toEqual(['cpu', 'vaapi'])
      expect(result.value.cpuCores).toBe(16)
    }
  })

  it('rejects an array where an object is expected', () => {
    expect(validateCapabilities([]).ok).toBe(false)
  })

  it('rejects a non-string encoder entry', () => {
    expect(validateCapabilities({ encoders: ['cpu', 7] }).ok).toBe(false)
  })

  it('rejects a non-finite scratch figure rather than storing NaN', () => {
    expect(validateCapabilities({ scratchFreeBytes: Number.NaN }).ok).toBe(false)
    expect(validateCapabilities({ scratchFreeBytes: 'lots' }).ok).toBe(false)
  })

  it('drops unknown keys instead of persisting them', () => {
    const result = validateCapabilities({ encoders: ['cpu'], arbitrary: { nested: true } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).not.toHaveProperty('arbitrary')
  })
})

describe('preferredEncoder', () => {
  it('prefers a verified accelerator over the CPU', () => {
    expect(preferredEncoder({ encoders: ['cpu', 'vaapi'] })).toBe('vaapi')
    expect(preferredEncoder({ encoders: ['cpu', 'vaapi', 'nvenc'] })).toBe('nvenc')
  })

  it('falls back to cpu when nothing was reported', () => {
    expect(preferredEncoder(null)).toBe('cpu')
    expect(preferredEncoder({ encoders: [] })).toBe('cpu')
  })
})
