import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * The launcher is the first thing a user runs, so its two easy-to-regress
 * properties are worth a test: `--help` must answer without installing, and a
 * wizard failure must reach the user instead of pnpm's wrapper error.
 */
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'bootstrap.sh')
const localTsx = join(repoRoot, 'setup', 'node_modules', '.bin', 'tsx')

// Without the wizard's own tsx there is nothing to hand over to; the launcher's
// fallback help still works but the wizard-related cases cannot run.
const maybe = existsSync(localTsx) ? describe : describe.skip

maybe('scripts/bootstrap.sh', () => {
  it('answers --help without installing anything', async () => {
    const result = await execa('bash', [scriptPath, '--help'], {
      reject: false,
      cwd: repoRoot,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage')
    expect(result.stdout).toContain('OPENVOD_SKIP_INSTALL')
    // The install step announces itself with this line; help must never reach it.
    expect(result.stdout).not.toContain('installing workspace dependencies')
  })

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
      expect(combined).toContain('.dev.vars')
    }
  })
})
