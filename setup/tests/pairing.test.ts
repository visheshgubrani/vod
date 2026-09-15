import { describe, expect, it } from 'vitest'
import {
  agentApiUrlNote,
  pairingCommand,
  PAIRING_API_PLACEHOLDER,
  PAIRING_CODE_PLACEHOLDER,
} from '../src/pairing'

/**
 * The pairing command is printed by the wizard, the docs and the dashboard, and
 * it is easy to get subtly wrong: `--api` belongs to the agent's argparse root,
 * so `pair --api …` fails with a usage error *after* the container starts.
 */
describe('pairingCommand', () => {
  it('puts the global --api before the pair subcommand', () => {
    const command = pairingCommand('https://api.example.com', 'ABCD-EFGH-IJ')
    expect(command).toContain('--api https://api.example.com pair --code ABCD-EFGH-IJ')
    // The failing form: the option after the subcommand.
    expect(command).not.toMatch(/pair\s+--api/)
  })

  it('does not start the bundled api/postgres/redis services', () => {
    // `docker compose run` starts depends_on services unless told not to; an
    // agent pointing at a Worker must not drag up a local API and database.
    expect(pairingCommand('https://api.example.com')).toContain('run --rm --no-deps transcoder')
  })

  it('falls back to placeholders when the values are not known yet', () => {
    const command = pairingCommand()
    expect(command).toContain(PAIRING_API_PLACEHOLDER)
    expect(command).toContain(PAIRING_CODE_PLACEHOLDER)
    expect(pairingCommand('   ', '  ')).toContain(PAIRING_API_PLACEHOLDER)
  })
})

describe('agentApiUrlNote', () => {
  it('explains the Compose service address for a Compose-hosted API', () => {
    expect(agentApiUrlNote(undefined, true)).toContain('http://api:4080')
  })

  it('tells a Worker/deployed API that the container needs a reachable address', () => {
    const note = agentApiUrlNote('https://api.example.com', false)
    expect(note).toContain('CLIPMUX_API_URL=https://api.example.com')
    expect(note).toContain('host.docker.internal')
  })
})
