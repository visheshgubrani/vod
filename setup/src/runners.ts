/**
 * Process runners. All CLI invocations go through here with argv arrays (no
 * shell interpolation) and optional live streaming. pnpm is always invoked
 * from the package directory whose local .bin should be used, so we never
 * fall back to `npx wrangler` (which would pull the latest wrangler instead
 * of the project-pinned devDependency).
 */

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execa } from 'execa'
import { WizardError } from './errors'

export interface Captured {
  code: number | null
  stdout: string
  stderr: string
  /** True when the process was killed by our timeout. */
  timedOut: boolean
  signal: string | null
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Disable with 0. Default 120s for capture, none for inherit. */
  timeoutMs?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

function splitArgv(argv: string[]): { file: string; args: string[] } {
  const file = argv[0]
  if (file === undefined || file === '') {
    throw new WizardError('process runner called with an empty argv')
  }
  return { file, args: argv.slice(1) }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString()
  return ''
}

function timeoutOption(timeoutMs: number | undefined): { timeout: number } | Record<string, never> {
  if (timeoutMs === undefined || timeoutMs <= 0) return {}
  return { timeout: timeoutMs }
}

function toCaptured(result: {
  exitCode?: number
  stdout: unknown
  stderr: unknown
  timedOut: boolean
  signal?: string
}): Captured {
  return {
    code: result.exitCode ?? null,
    stdout: asText(result.stdout),
    stderr: asText(result.stderr),
    timedOut: result.timedOut,
    signal: result.signal ?? null,
  }
}

/** Captured run; never throws — inspect Captured.code. */
export async function runCapture(argv: string[], options: RunOptions = {}): Promise<Captured> {
  const { file, args } = splitArgv(argv)
  const timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs
  try {
    const subprocess = execa(file, args, {
      cwd: options.cwd,
      env: options.env,
      reject: false,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...timeoutOption(timeoutMs),
    })
    subprocess.stdout?.on('data', (chunk: Buffer | string) => {
      options.onStdout?.(typeof chunk === 'string' ? chunk : chunk.toString())
    })
    subprocess.stderr?.on('data', (chunk: Buffer | string) => {
      options.onStderr?.(typeof chunk === 'string' ? chunk : chunk.toString())
    })
    return toCaptured(await subprocess)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      code: null,
      stdout: '',
      stderr: message,
      timedOut: false,
      signal: null,
    }
  }
}

/** Interactive run (stdio inherited so auth CLIs can show their URLs). */
export async function runInherit(argv: string[], options: RunOptions = {}): Promise<number | null> {
  const { file, args } = splitArgv(argv)
  try {
    const result = await execa(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      reject: false,
      ...timeoutOption(options.timeoutMs),
    })
    return result.exitCode ?? null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WizardError(`could not run "${file}": ${message}`)
  }
}

/** Fast synchronous existence probe for a binary on PATH. */
export function findOnPath(bin: string): string | null {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    const candidate = join(dir, bin)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // continue searching
    }
  }
  return null
}

export interface PkgExec {
  argv: string[]
  cwd: string
}

/**
 * Build a `pnpm exec <bin>` invocation scoped to a workspace package. pnpm
 * resolves <bin> from that package's local node_modules/.bin.
 */
export function pkgExec(root: string, pkgDir: string, bin: string, args: string[]): PkgExec {
  return { argv: ['pnpm', 'exec', bin, ...args], cwd: join(root, pkgDir) }
}

export function pkgCapture(
  root: string,
  pkgDir: string,
  bin: string,
  args: string[],
  options: RunOptions = {},
): Promise<Captured> {
  const spec = pkgExec(root, pkgDir, bin, args)
  return runCapture(spec.argv, { ...options, cwd: spec.cwd })
}

export function pkgInherit(
  root: string,
  pkgDir: string,
  bin: string,
  args: string[],
  options: RunOptions = {},
): Promise<number | null> {
  const spec = pkgExec(root, pkgDir, bin, args)
  return runInherit(spec.argv, { ...options, cwd: spec.cwd })
}
