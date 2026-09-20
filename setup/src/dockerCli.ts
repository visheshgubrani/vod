/**
 * How this process should invoke Docker.
 *
 * The host installer may decide that `docker` works as this user, or that
 * `sudo -n docker` is the only working path. Either way the rest of the
 * wizard must use the same argv — adding the user to the `docker` group or
 * running the whole wizard as root is not a decision it gets to make.
 *
 * Override with CLIPMUX_DOCKER (space-separated), e.g. `sudo -n docker`.
 */

export function dockerArgv(): string[] {
  const raw = (process.env.CLIPMUX_DOCKER ?? 'docker').trim()
  const parts = raw.split(/\s+/).filter((part) => part !== '')
  return parts.length > 0 ? parts : ['docker']
}

export function dockerCmd(...args: string[]): string[] {
  return [...dockerArgv(), ...args]
}
