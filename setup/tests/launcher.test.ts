import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * The launcher is the first thing a user runs, so its easy-to-regress
 * properties are worth a test: read-only modes must change nothing, `--help`
 * must answer without installing, and a wizard failure must reach the user
 * instead of pnpm's wrapper error.
 */
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'bootstrap.sh')
const localTsx = join(repoRoot, 'setup', 'node_modules', '.bin', 'tsx')

/**
 * Do the *wizard* tests require a runnable tsx, or merely a present one?
 *
 * `existsSync` alone was the old gate, and it is not enough: a sandbox that
 * blocks tsx's IPC makes every wizard-backed case fail with an error that has
 * nothing to do with the launcher. So the probe actually runs it once, and the
 * suite skips with a reason instead of red-flagging an environment limitation.
 */
const tsxUsable = await (async (): Promise<boolean> => {
  if (!existsSync(localTsx)) return false
  try {
    const result = await execa(localTsx, ['--version'], { reject: false, timeout: 30_000 })
    return result.exitCode === 0
  } catch {
    return false
  }
})()

const maybe = tsxUsable ? describe : describe.skip

describe('scripts/bootstrap.sh (read-only modes)', () => {
  it('answers --help without installing anything', async () => {
    const result = await execa('bash', [scriptPath, '--help'], {
      reject: false,
      cwd: repoRoot,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage')
    expect(result.stdout).toContain('OPENVOD_SKIP_INSTALL')
    expect(result.stdout).toContain('--doctor')
    // The install step announces itself with this line; help must never reach it.
    expect(result.stdout).not.toContain('installing workspace dependencies')
    expect(result.stdout).not.toContain('installing node')
    expect(result.stdout).not.toContain('installing pnpm')
  })

  it('reports the environment under --doctor without changing anything', async () => {
    const result = await execa('bash', [scriptPath, '--doctor'], {
      reject: false,
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })
    const combined = result.stdout + result.stderr
    expect(combined).toContain('environment')
    expect(combined).not.toContain('installing workspace dependencies')
    expect(combined).not.toContain('installing node')
    expect(combined).not.toContain('installing pnpm')
    // It reports what is here; missing pieces are findings, not installs.
    expect(combined).toMatch(/curl|node|pnpm/)
  })

  it('never escalates privileges', async () => {
    // `sudo` is not on PATH in this environment; if the launcher needed it the
    // read-only modes would still succeed, and an accidental call would show up
    // as a command-not-found in the output.
    const result = await execa('bash', [scriptPath, '--doctor'], {
      reject: false,
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })
    const combined = result.stdout + result.stderr
    expect(combined).not.toContain('sudo sh -c')
    expect(combined).not.toContain('password for')
  })
})

maybe('scripts/bootstrap.sh (wizard handover)', () => {
  it('passes a usage error through without pnpm wrapper noise', async () => {
    const result = await execa('bash', [scriptPath, '--definitely-not-a-flag'], {
      reject: false,
      cwd: repoRoot,
      env: { OPENVOD_SKIP_INSTALL: '1' },
    })
    expect(result.exitCode).toBe(2)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('unknown argument')
    // `pnpm --filter … exec` used to append ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
    // after every wizard error, which buried the actual message.
    expect(combined).not.toContain('ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL')
  })

  it('keeps an already-configured non-interactive run a success', async () => {
    const result = await execa('bash', [scriptPath], {
      reject: false,
      cwd: repoRoot,
      env: { OPENVOD_SKIP_INSTALL: '1' },
    })
    // Either there is no configuration yet (the wizard refuses to run without a
    // terminal → 1) or there is (report + exit 0). Both must be explained.
    expect([0, 1]).toContain(result.exitCode)
    const combined = result.stdout + result.stderr
    expect(combined).not.toContain('ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL')
    if (result.exitCode === 0) {
      expect(combined).toContain('already exists')
    }
  })

  it('refuses a headless --answers run when the wizard cannot start, without installing', async () => {
    const result = await execa('bash', [scriptPath, '--answers', '/nonexistent/answers.json'], {
      reject: false,
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })
    const combined = result.stdout + result.stderr
    expect(combined).not.toContain('installing workspace dependencies')
    // Either the wizard ran and rejected the missing file (1), or the launcher
    // explained that the dependencies are missing (1). Never a silent success.
    expect(result.exitCode).toBe(1)
  })
})
