import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { execa } from 'execa'

/**
 * `scripts/install.sh` is the operator entrypoint. These tests stub
 * provisioning: they never install Docker, never clone, and never start the
 * wizard. CLIPMUX_SKIP_PROVISION=1 stops before those steps.
 */
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'install.sh')
const libDir = join(repoRoot, 'scripts', 'lib')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NO_COLOR: '1',
    CLIPMUX_INSTALL_LIB: libDir,
    CLIPMUX_SKIP_DOCKER_INSTALL: '1',
    ...extra,
  }
}

interface RunResult {
  stdout: string
  stderr: string
  combined: string
  exitCode: number
}

function ttyFile(): string {
  const dir = tempDir('clipmux-tty-')
  const path = join(dir, 'tty')
  writeFileSync(path, '')
  return path
}

async function runInstaller(
  args: string[],
  options: {
    env?: Record<string, string>
    pipe?: boolean
    cwd?: string
  } = {},
): Promise<RunResult> {
  const env = baseEnv(options.env)
  const cwd = options.cwd ?? repoRoot

  if (options.pipe) {
    const extra = args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')
    const result = await execa('bash', ['-c', `cat "$SCRIPT" | bash ${extra}`], {
      reject: false,
      cwd,
      env: { ...env, SCRIPT: scriptPath },
    })
    return wrap(result)
  }

  const result = await execa('bash', [scriptPath, ...args], { reject: false, cwd, env })
  return wrap(result)
}

function wrap(result: {
  stdout: string
  stderr: string
  exitCode?: number | null
}): RunResult {
  const stdout = result.stdout
  const stderr = result.stderr
  return {
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
    exitCode: result.exitCode ?? -1,
  }
}

function writeFakeCheckout(dir: string): void {
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(dir, 'docker-compose.yml'), 'name: clipmux\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"clipmux"}\n')
}

function writeState(dir: string, commit = 'abc123'): void {
  writeFileSync(
    join(dir, '.clipmux-install'),
    `owner=install.sh\nversion=main\ncommit=${commit}\ndir=${dir}\n`,
  )
}

function stubBin(dir: string, name: string, body: string): string {
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return binDir
}

describe('scripts/install.sh (read-only modes)', () => {
  it('is syntactically valid', async () => {
    const result = await execa('bash', ['-n', scriptPath], { reject: false })
    expect(result.exitCode).toBe(0)
  })

  it('answers --help without installing or writing', async () => {
    const dest = tempDir('clipmux-help-')
    const result = await runInstaller(['--help'], { env: { CLIPMUX_DIR: dest } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage')
    expect(result.stdout).toContain('--doctor')
    expect(result.stdout).toContain('CLIPMUX_VERSION')
    expect(result.stdout).toContain('the URL ref and CLIPMUX_VERSION must be the same')
    expect(result.combined).not.toContain('installing Docker')
    expect(result.combined).not.toContain('cloning')
    expect(existsSync(join(dest, '.clipmux-install'))).toBe(false)
    expect(existsSync(join(dest, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('reports the environment under --doctor without changing anything', async () => {
    const dest = tempDir('clipmux-doctor-')
    const result = await runInstaller(['--doctor'], { env: { CLIPMUX_DIR: dest } })
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain('environment')
    expect(result.combined).toContain(`CLIPMUX_DIR=${dest}`)
    expect(result.combined).not.toContain('installing Docker')
    expect(result.combined).not.toContain('cloning')
    expect(result.combined).not.toContain('get.docker.com')
    expect(existsSync(join(dest, '.clipmux-install'))).toBe(false)
  })

  it('never uses Docker convenience-script URLs', () => {
    const source = readFileSync(scriptPath, 'utf8')
    expect(source).not.toContain('get.docker.com')
    expect(source).toContain('download.docker.com/linux')
    expect(source).toContain('docker-ce')
  })
})

describe('scripts/install.sh (piped execution)', () => {
  it('exits before provisioning when there is no usable terminal', async () => {
    const dest = tempDir('clipmux-notty-')
    const result = await runInstaller([], {
      pipe: true,
      env: {
        CLIPMUX_DIR: dest,
        CLIPMUX_TTY: join(dest, 'no-such-tty'),
      },
    })
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatch(/interactive terminal/)
    expect(result.combined).not.toContain('cloning')
    expect(result.combined).not.toContain('installing Docker')
    expect(existsSync(join(dest, '.clipmux-install'))).toBe(false)
    expect(existsSync(join(dest, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('reconnects stdin to CLIPMUX_TTY when piped', async () => {
    const dest = tempDir('clipmux-pipe-tty-')
    const result = await runInstaller([], {
      pipe: true,
      env: {
        CLIPMUX_DIR: dest,
        CLIPMUX_TTY: ttyFile(),
        CLIPMUX_SKIP_PROVISION: '1',
        CLIPMUX_VERSION: 'main',
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain('CLIPMUX_SKIP_PROVISION=1')
    expect(result.combined).toContain(`CLIPMUX_DIR=${dest}`)
    expect(result.combined).not.toContain('cloning')
    expect(result.combined).not.toContain('installing Docker Engine from Docker')
  })
})

describe('scripts/install.sh (destination, version, docker, rerun)', () => {
  it('refuses an unrelated nonempty destination', async () => {
    const dest = tempDir('clipmux-foreign-')
    writeFileSync(join(dest, 'notes.txt'), 'not clipmux\n')
    const result = await runInstaller([], {
      env: { CLIPMUX_DIR: dest, CLIPMUX_SKIP_PROVISION: '1', CLIPMUX_TTY: ttyFile() },
    })
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatch(/refusing to install/)
    expect(result.combined).not.toContain('CLIPMUX_SKIP_PROVISION=1')
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toContain('not clipmux')
    expect(existsSync(join(dest, '.clipmux-install'))).toBe(false)
  })

  it('records a pinned CLIPMUX_VERSION without inferring it from a URL', async () => {
    const dest = tempDir('clipmux-pin-')
    const result = await runInstaller([], {
      env: {
        CLIPMUX_DIR: dest,
        CLIPMUX_TTY: ttyFile(),
        CLIPMUX_SKIP_PROVISION: '1',
        CLIPMUX_VERSION: 'c0ffee12',
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain('CLIPMUX_VERSION=c0ffee12')
    expect(result.combined).not.toMatch(/inferred|guessed the ref/i)
  })

  it('uses docker on PATH when `docker info` works, without installing', async () => {
    const dest = tempDir('clipmux-docker-')
    const fixtures = tempDir('clipmux-docker-fx-')
    const bin = stubBin(
      fixtures,
      'docker',
      'if [ "$1" = "info" ] || [ "$1" = "--version" ]; then echo "Docker version test"; exit 0; fi; exit 0',
    )
    const result = await runInstaller([], {
      env: {
        CLIPMUX_DIR: dest,
        CLIPMUX_TTY: ttyFile(),
        CLIPMUX_SKIP_PROVISION: '1',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain('docker=docker')
    expect(result.combined).not.toContain('installing Docker Engine')
  })

  it('selects sudo -n docker when the unprivileged client cannot reach the daemon', async () => {
    const dest = tempDir('clipmux-sudo-docker-')
    const fixtures = tempDir('clipmux-sudo-docker-fx-')
    const bin = stubBin(fixtures, 'docker', 'echo "permission denied" >&2; exit 1')
    writeFileSync(
      join(bin, 'sudo'),
      `#!/bin/sh\n[ "$1" = "-n" ] || exit 1\nshift\n[ "$1" = "docker" ] || exit 1\nshift\nif [ "$1" = "info" ] || [ "$1" = "--version" ]; then echo ok; exit 0; fi\nexit 0\n`,
    )
    chmodSync(join(bin, 'sudo'), 0o755)
    const result = await runInstaller([], {
      env: {
        CLIPMUX_DIR: dest,
        CLIPMUX_TTY: ttyFile(),
        CLIPMUX_SKIP_PROVISION: '1',
        CLIPMUX_NO_SUDO: '0',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain('docker=sudo -n docker')
  })

  it('does not install Docker when CLIPMUX_SKIP_DOCKER_INSTALL=1', async () => {
    const dest = tempDir('clipmux-skip-docker-')
    const fixtures = tempDir('clipmux-skip-docker-fx-')
    const osRelease = join(fixtures, 'os-release')
    writeFileSync(osRelease, 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n')
    const bin = stubBin(fixtures, 'docker', 'exit 1')
    const result = await runInstaller([], {
      env: {
        CLIPMUX_DIR: dest,
        CLIPMUX_TTY: ttyFile(),
        CLIPMUX_SKIP_DOCKER_INSTALL: '1',
        CLIPMUX_UNAME_OVERRIDE: 'Linux',
        CLIPMUX_OS_RELEASE_FILE: osRelease,
        CLIPMUX_NO_SUDO: '1',
        PATH: `${bin}:/usr/bin:/bin`,
      },
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.combined).toMatch(/CLIPMUX_SKIP_DOCKER_INSTALL=1|not installing Docker/)
    expect(result.combined).not.toContain('apt-get install -y docker-ce')
    expect(existsSync(join(dest, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('reuses an existing install without fetching or rotating', async () => {
    const dest = tempDir('clipmux-rerun-')
    writeFakeCheckout(dest)
    writeState(dest, 'deadbeef')
    const before = readFileSync(join(dest, '.clipmux-install'), 'utf8')
    const result = await runInstaller([], {
      env: {
        CLIPMUX_DIR: dest,
        CLIPMUX_TTY: ttyFile(),
        CLIPMUX_SKIP_PROVISION: '1',
        CLIPMUX_VERSION: 'should-not-fetch',
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.combined).toMatch(/existing ClipMux install/)
    expect(result.combined).toContain('rerun=1')
    expect(result.combined).not.toContain('cloning')
    expect(readFileSync(join(dest, '.clipmux-install'), 'utf8')).toBe(before)
  })
})
