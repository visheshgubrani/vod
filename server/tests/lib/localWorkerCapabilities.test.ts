import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PYTHON_HEARTBEAT = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/local-worker-heartbeat.json'), 'utf8'),
) as { capabilities: Record<string, unknown> }
import { buildPublicCapabilities, isLocalWorkerLive, validateCapabilities } from '../../src/lib/localWorkerCapabilities'

const NOW = Date.parse('2026-03-01T12:00:00Z')

function input(overrides: Record<string, unknown> = {}) {
  return {
    modalConfigured: true,
    localConfigured: true,
    localEnabled: true,
    localWorkerOnline: true,
    localImportConfigured: true,
    rawBucket: 'clipmux-raw',
    transcodedBucket: 'clipmux-transcoded',
    hasStorageCredentials: true,
    defaultProvider: 'local',
    aiEnabled: false,
    workerCapabilities: { transcription: true, encoders: ['cpu'] },
    ...overrides,
  } as Parameters<typeof buildPublicCapabilities>[0]
}

describe('isLocalWorkerLive', () => {
  it('counts a recent heartbeat as online and an expired one as offline', () => {
    expect(isLocalWorkerLive(new Date(NOW - 5_000), NOW)).toBe(true)
    expect(isLocalWorkerLive(new Date(NOW - 90_001), NOW)).toBe(false)
    expect(isLocalWorkerLive(null, NOW)).toBe(false)
  })
})

describe('buildPublicCapabilities', () => {
  it('reports the configured provider and a coarse singleton worker status', () => {
    const caps = buildPublicCapabilities(input())
    expect(caps.providers).toEqual(['modal', 'local'])
    expect(caps.defaultProvider).toBe('local')
    expect(caps.localWorker).toEqual({ online: true })
    expect(caps.localImport).toBe(true)
  })

  it('reports local-only imports without Modal or a raw bucket', () => {
    const caps = buildPublicCapabilities(input({ modalConfigured: false, rawBucket: null }))
    expect(caps.providers).toEqual(['local'])
    expect(caps.localImport).toBe(true)
    expect(caps.uploads).toBe(false)
  })

  it('withdraws local import while the worker is offline or disabled', () => {
    expect(buildPublicCapabilities(input({ localWorkerOnline: false })).localImport).toBe(false)
    expect(buildPublicCapabilities(input({ localEnabled: false })).providers).toEqual(['modal'])
  })

  it('validates worker capability shape without accepting arbitrary values', () => {
    expect(validateCapabilities({ encoders: ['cpu'], transcription: true })).toMatchObject({ ok: true })
    expect(validateCapabilities({ encoders: [1] })).toMatchObject({ ok: false })
    expect(validateCapabilities(PYTHON_HEARTBEAT.capabilities)).toEqual({
      ok: true,
      value: PYTHON_HEARTBEAT.capabilities,
    })
  })
})
