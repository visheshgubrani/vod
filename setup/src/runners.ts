/**
 * Process runners. All CLI invocations go through here with argv arrays (no
 * shell interpolation) and optional live streaming. pnpm is always invoked
 * from the package directory whose local .bin should be used, so we never
 * fall back to `npx wrangler` (which would pull the latest wrangler instead
 * of the project-pinned devDependency).
 */

import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
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

/** Captured run; never throws — inspect Captured.code. */
export function runCapture(argv: string[], options: RunOptions = {}): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      options.onStdout?.(text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      options.onStderr?.(text)
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 0)

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
        timedOut,
        signal: null,
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, signal })
    })
  })
}

/** Interactive run (stdio inherited so auth CLIs can show their URLs). */
export function runInherit(argv: string[], options: RunOptions = {}): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(new WizardError(`could not run "${argv[0]}": ${error.message}`))
    })
    child.on('close', (code) => resolve(code))
  })
}

/** Fast synchronous existence probe for a binary on PATH. */
export function findOnPath(bin: string): string | null {
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of pathDirs) {
    try {
      const candidate = join(dir, bin)
      const result = spawnSync('test', ['-x', candidate])
      if (result.status === 0) return candidate
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
