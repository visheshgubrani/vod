import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execa } from 'execa'

/**
 * `scripts/lib/detect.sh` is the one place the OS family and the package-manager
 * verdict are decided — the launcher needs it before any Node exists, and the
 * wizard consumes its `--dump` instead of keeping a second table. These tests
 * run the real script with fixture `os-release` files, so a distro that is
 * mapped wrongly fails here rather than on someone's machine.
 */
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const detectScript = join(repoRoot, 'scripts', 'lib', 'detect.sh')
const pkgTable = join(repoRoot, 'scripts', 'lib', 'pkg-commands.tsv')

const FIXTURES: Record<string, string> = {
  ubuntu: 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n',
  debian: 'ID=debian\nVERSION_ID="12"\n',
  fedora: 'ID=fedora\nID_LIKE="rhel fedora"\n',
  rocky: 'ID="rocky"\nID_LIKE="rhel centos fedora"\n',
  arch: 'ID=arch\nID_LIKE=archlinux\n',
  alpine: 'ID=alpine\nVERSION_ID=3.20\n',
  opensuse: 'ID="opensuse-leap"\nID_LIKE="suse opensuse"\n',
  gentoo: 'ID=gentoo\n',
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clipmux-detect-'))
  for (const [name, text] of Object.entries(FIXTURES)) {
    writeFileSync(join(dir, name), text)
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runDetect(
  script: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const result = await execa('bash', ['-c', script], {
    cwd: repoRoot,
    reject: false,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? -1,
  }
}

/** Source the detector, apply a fixture, and dump the verdict. */
function dumpFor(fixture: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return runDetect(
    `. scripts/lib/detect.sh\nov_detect_all\nov_dump`,
    { CLIPMUX_OS_RELEASE_FILE: join(dir, fixture), ...extraEnv },
  )
}

function field(dump: string, key: string): string {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(dump)
  return match ? match[1] : ''
}

describe('scripts/lib/detect.sh', () => {
  it('is syntactically valid', async () => {
    const result = await runDetect('bash -n scripts/lib/detect.sh')
    expect(result.exitCode).toBe(0)
  })

  it('maps each distro family to the right package manager', async () => {
    const expectations: Array<[fixture: string, family: string, manager: string]> = [
      ['ubuntu', 'debian', 'apt-get'],
      ['debian', 'debian', 'apt-get'],
      ['fedora', 'rpm', 'dnf'],
      ['rocky', 'rpm', 'dnf'],
      ['arch', 'arch', 'pacman'],
      ['alpine', 'alpine', 'apk'],
      ['opensuse', 'suse', 'zypper'],
    ]
    for (const [fixture, family, manager] of expectations) {
      const dump = (await dumpFor(fixture)).stdout
      expect(`${fixture}:${field(dump, 'FAMILY')}:${field(dump, 'MANAGER')}`).toBe(
        `${fixture}:${family}:${manager}`,
      )
    }
  })

  it('reports an unknown family rather than guessing', async () => {
    const dump = (await dumpFor('gentoo')).stdout
    expect(field(dump, 'FAMILY')).toBe('unknown')
    expect(field(dump, 'MANAGER')).toBe('')
  })

  it('detects macOS from uname and uses Homebrew', async () => {
    const result = await runDetect('. scripts/lib/detect.sh\nov_detect_all\nov_dump', {
      CLIPMUX_UNAME_OVERRIDE: 'Darwin',
    })
    expect(field(result.stdout, 'OS')).toBe('macos')
    expect(field(result.stdout, 'FAMILY')).toBe('mac')
    expect(field(result.stdout, 'MANAGER')).toBe('brew')
  })

  it('needs neither root nor sudo on a machine that has neither', async () => {
    const dump = (await dumpFor('ubuntu')).stdout
    // NOT a claim about the machine running the suite: CLIPMUX_NO_SUDO below is
    // what makes the policy testable without privileges.
    expect(['0', '1']).toContain(field(dump, 'CAN_INSTALL'))
    const forced = (await dumpFor('ubuntu', { CLIPMUX_NO_SUDO: '1' })).stdout
    expect(field(forced, 'NO_SUDO')).toBe('1')
    expect(field(forced, 'CAN_INSTALL')).toBe('0')
    expect(field(forced, 'HAS_SUDO')).toBe('0')
  })

  it('refuses to install anything when escalation is forbidden', async () => {
    const result = await runDetect(
      [
        '. scripts/lib/detect.sh',
        'ov_detect_all',
        'if ov_run_pkg python3; then echo RAN; else echo REFUSED; fi',
      ].join('\n'),
      { CLIPMUX_OS_RELEASE_FILE: join(dir, 'ubuntu'), CLIPMUX_NO_SUDO: '1' },
    )
    expect(result.stdout.trim()).toBe('REFUSED')
  })

  it('reads install commands from the shared package table', async () => {
    const result = await runDetect(
      [
        '. scripts/lib/detect.sh',
        'ov_detect_all',
        'printf "PY=%s\\n" "$(ov_pkg_command python3)"',
        'printf "HINT=%s\\n" "$(ov_pkg_hint python3)"',
        'printf "MISSING=%s\\n" "$(ov_pkg_command docker || printf none)"',
      ].join('\n'),
      { CLIPMUX_OS_RELEASE_FILE: join(dir, 'ubuntu') },
    )
    expect(result.stdout).toContain('PY=apt-get install -y python3 python3-venv python3-pip')
    // The hint is what a user runs themselves, so it carries the sudo prefix.
    expect(result.stdout).toContain('HINT=sudo apt-get install -y python3 python3-venv python3-pip')
    // Docker is deliberately absent from the table (see the file's header).
    expect(result.stdout).toContain('MISSING=none')
  })

  it('answers --dump when executed, and stays inert when sourced', async () => {
    const executed = await runDetect('bash scripts/lib/detect.sh --dump')
    expect(executed.exitCode).toBe(0)
    expect(executed.stdout).toContain('FAMILY=')

    const sourced = await runDetect('. scripts/lib/detect.sh\nprintf "done\\n"')
    expect(sourced.stdout.trim()).toBe('done')
    expect(sourced.exitCode).toBe(0)
  })
})

describe('scripts/lib/pkg-commands.tsv', () => {
  it('has a row for every installable capability on every family it claims', () => {
    const rows = readFileSync(pkgTable, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
      .map((line) => line.split('|'))

    const families = new Set(['debian', 'rpm', 'arch', 'suse', 'alpine', 'mac'])
    const capabilities = new Set(['curl', 'git', 'node', 'python3', 'ffmpeg'])
    for (const capability of capabilities) {
      const covered = new Set(
        rows.filter((row) => row[0] === capability).map((row) => row[1]),
      )
      expect([...families].filter((family) => !covered.has(family))).toEqual([])
    }
    for (const row of rows) {
      expect(row).toHaveLength(3)
      expect(families.has(row[1])).toBe(true)
    }
  })

  it('never interpolates anything user-supplied: commands are static text', () => {
    const commands = readFileSync(pkgTable, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
      .map((line) => line.split('|')[2])
      .join('\n')
    // No shell expansions of variables or command substitution on a data row: a
    // `${...}` or `$(...)` here would mean a value could reach a privileged shell.
    expect(commands).not.toMatch(/\$\{|\$\(|`/)
  })
})

describe('bash 3.2 (macOS /bin/bash)', () => {
  const maybeDocker = process.env.CLIPMUX_BASH32_BIN ?? null

  it('runs the detector under real bash 3.2', async () => {
    const image = 'bash:3.2'
    const script = [
      'set -e',
      '. /w/scripts/lib/detect.sh',
      'ov_detect_all',
      'ov_dump',
      'printf "PY=%s\\n" "$(ov_pkg_hint python3)"',
      'printf "REFUSED=%s\\n" "$(CLIPMUX_NO_SUDO=1 bash -c ". /w/scripts/lib/detect.sh; ov_detect_all; ov_run_pkg python3 || echo yes")"',
    ].join('\n')

    const result = maybeDocker !== null
      ? await execa(maybeDocker, ['-c', script], { reject: false, cwd: repoRoot })
      : await execa(
          'docker',
          ['run', '--rm', '-v', `${repoRoot}:/w:ro`, '-w', '/w', image, 'bash', '-c', script],
          { reject: false, timeout: 180_000 },
        )

    if (result.exitCode !== 0 && /docker|Cannot connect|permission denied/i.test(result.stderr)) {
      // Same contract as the DB suites: skip cleanly when the environment
      // cannot provide the thing under test.
      console.warn('bash 3.2 container unavailable — skipping')
      return
    }
    expect(result.stderr).not.toContain('syntax error')
    expect(result.stdout).toContain('FAMILY=')
    expect(result.stdout).toContain('PY=')
    expect(result.stdout).toContain('REFUSED=yes')
  }, 200_000)
})
