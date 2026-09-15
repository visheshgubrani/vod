/**
 * Running an install command.
 *
 * There is exactly one policy, shared with the bash launcher: we elevate only
 * when we are root or have passwordless sudo, and we never prompt for a
 * password. A sudo password prompt inside the wizard's TUI corrupts the
 * terminal, and "the script installed a system package after asking for my
 * password" is not a decision anyone wants to discover afterwards.
 *
 * The commands themselves come from `scripts/lib/pkg-commands.tsv` — repo data,
 * never interpolated with anything the user typed — which is why running them
 * through `sh -c` is safe here.
 */

import { runInherit } from './runners'

export interface InstallResult {
  ok: boolean
  /** Short reason, shown when the install fails. */
  message: string
}

export interface InstallOptions {
  cwd: string
  isRoot: boolean
}

export async function runInstallCommand(
  command: string,
  options: InstallOptions,
): Promise<InstallResult> {
  const argv = options.isRoot
    ? ['sh', '-c', command]
    : ['sudo', 'sh', '-c', command]
  try {
    const code = await runInherit(argv, { cwd: options.cwd })
    if (code === 0) return { ok: true, message: 'installed' }
    return { ok: false, message: `the installer exited ${String(code)}` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
