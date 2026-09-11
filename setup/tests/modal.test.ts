import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { transcodingDeployRequirements, transcodingVenvModalBin } from '../src/modal'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

describe('transcodingVenvModalBin', () => {
  it('points at transcoding/.venv, not a global uv/pipx modal', () => {
    expect(transcodingVenvModalBin('/repo')).toBe('/repo/transcoding/.venv/bin/modal')
  })
})

describe('transcoding/requirements-deploy.txt', () => {
  it('lists local hydrate deps so modal deploy can import main.py', () => {
    const packages = readFileSync(transcodingDeployRequirements(repoRoot), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
    expect(packages).toEqual(['boto3', 'requests', 'fastapi', 'modal>=1.5.0'])
  })
})
