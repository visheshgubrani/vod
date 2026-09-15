/**
 * The self-hosted transcoder agent: how the wizard tells someone to pair a
 * machine, and what that machine needs to reach.
 *
 * Pure strings on purpose. The pairing invocation is the single most
 * copy-pasted command this project prints, and it is easy to get wrong in a way
 * nobody notices until an operator runs it: `--api` is a **global** option on
 * the agent's argparse root (`transcoding/openvod_transcoder/agent/cli.py`), so
 * it must come *before* the `pair` subcommand — `pair --api …` is a parse error.
 */

/** Placeholder used when the API URL is not known yet. */
export const PAIRING_API_PLACEHOLDER = '<your API URL>'
export const PAIRING_CODE_PLACEHOLDER = '<CODE FROM THE DASHBOARD>'

/**
 * The command that redeems a pairing code, in the argument order argparse
 * actually accepts. `--no-deps` keeps `docker compose run` from starting the
 * bundled `api`/`postgres`/`redis` services, which is wrong for every case
 * except a Compose-hosted API — and that one does not need this command.
 */
export function pairingCommand(apiUrl?: string, code?: string): string {
  const api = (apiUrl ?? '').trim() || PAIRING_API_PLACEHOLDER
  const pairingCode = (code ?? '').trim() || PAIRING_CODE_PLACEHOLDER
  return (
    'docker compose --profile transcoder run --rm --no-deps transcoder \\\n' +
    `    --api ${api} pair --code ${pairingCode}`
  )
}

/**
 * What an agent container can and cannot reach.
 *
 * The container's `OPENVOD_API_URL` default is the Compose service address
 * (`http://api:4080`), which only resolves while the bundled API service is
 * running. Any other API — a Worker, a tunnel, or `pnpm dev` on this same
 * machine — has to be given an address that works *from inside the container*,
 * and that is a different address per case. Getting this wrong shows up as an
 * agent that pairs and then never claims a job.
 */
export function agentApiUrlNote(apiUrl: string | undefined, apiIsComposeService: boolean): string {
  if (apiIsComposeService) {
    return (
      'The agent talks to the Compose API service (OPENVOD_API_URL=http://api:4080), ' +
      'which resolves while `docker compose up` runs the bundled api service.'
    )
  }
  const api = (apiUrl ?? '').trim() || PAIRING_API_PLACEHOLDER
  return (
    `Set OPENVOD_API_URL=${api} for the transcoder service — the container must be able to reach it.\n` +
    'A public API URL works as-is; an API running on this machine needs the host address\n' +
    '(`http://host.docker.internal:<port>`, which docker-compose.yml maps on Linux too).'
  )
}
