#!/usr/bin/env node
/**
 * Signal-safe dev runner — replaces `pnpm --parallel --filter ... dev`.
 *
 * Why this exists: `pnpm --parallel` spawns each package script in its own
 * process group. A terminal Ctrl-C (SIGINT) only reaches the foreground
 * group (the parent pnpm), so the parent exits while `tsx watch` / `next dev`
 * / `wrangler dev` keep running as orphans holding 8787/3000. The next
 * `pnpm dev` then fails with EADDRINUSE (and Next's `.next/dev/lock`
 * complains) even though "nothing" looks running.
 *
 * This runner spawns the same `pnpm --filter <pkg> <script>` commands but:
 * - forwards SIGINT/SIGTERM to the whole descendant tree (not just the
 *   direct pnpm child, and not via process groups which pnpm splits),
 * - SIGKILLs stragglers after a grace period,
 * - kills the sibling services when one exits unexpectedly,
 * - clears a stale Next dev lock when the port is actually free.
 *
 * Zero dependencies, Node >= 22. Linux + macOS.
 *
 * Usage (via root package.json):
 *   node scripts/dev.mjs dev          # api (tsx watch :8787) + web (next :3000)
 *   node scripts/dev.mjs dev:all      # + delivery (:8788) + sdk/player watch
 *   node scripts/dev.mjs start        # production artifacts (api + web)
 *   node scripts/dev.mjs cleanup      # kill stale dev processes + stale lock
 */

import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** The repo root, exported so tests can build paths the module will resolve. */
export const REPO_ROOT = path.resolve(__dirname, '..')

const GRACE_MS = 5000
const NEXT_LOCK = path.join(REPO_ROOT, 'web', '.next', 'dev', 'lock')

const SERVICES = {
  api: { label: 'server dev', args: ['--filter', 'vod-api', 'dev'] },
  web: { label: 'web dev', args: ['--filter', 'web', 'dev'] },
  delivery: { label: 'delivery dev', args: ['--filter', 'delivery', 'dev'] },
  sdk: { label: 'sdk dev', args: ['--filter', '@clipmux/uploader', 'dev'] },
  player: { label: 'player dev', args: ['--filter', '@clipmux/player', 'dev'] },
  'api:start': { label: 'server start', args: ['--filter', 'vod-api', 'start'] },
  'web:start': { label: 'web start', args: ['--filter', 'web', 'start'] },
}

const PRESETS = {
  dev: ['api', 'web'],
  'dev:all': ['api', 'web', 'delivery', 'sdk', 'player'],
  start: ['api:start', 'web:start'],
}

/**
 * Workspace packages the app imports from their *built* output.
 *
 * `@clipmux/uploader` and `@clipmux/player` resolve to `dist/`, and `dist/` is
 * gitignored — so a fresh clone, a branch switch, or a rename inside `sdk/`
 * leaves the dashboard compiling against an older build. Nothing here rebuilds
 * it: the failure arrives as a Next compile error in the browser ("Export
 * ClipMuxUploader doesn't exist in target module") with no hint that a build is
 * what is missing. These are checked before any service starts.
 *
 * `@clipmux/server` is build-only (the dashboard never imports it) but is
 * included for the presets that already build the other two, so `pnpm dev:all`
 * and `examples/` agree.
 */
const WORKSPACE_PACKAGES = {
  sdk: { filter: '@clipmux/uploader', label: 'sdk' },
  player: { filter: '@clipmux/player', label: 'player' },
  'server-sdk': { filter: '@clipmux/server', label: 'server-sdk' },
}

/** The packages each preset must have built before its services start. */
const PRESET_PACKAGES = {
  dev: ['sdk', 'player'],
  'dev:all': ['sdk', 'player', 'server-sdk'],
  // `pnpm start` runs `next build`, which consumes the same two packages.
  start: ['sdk', 'player'],
}

/** Every package, for tests and for callers that want the whole set. */
export const PACKAGE_FILTERS = Object.entries(WORKSPACE_PACKAGES).map(([dir, pkg]) => ({
  dir,
  ...pkg,
}))

/** The workspace packages this preset must have built. */
function packagesFor(preset) {
  const dirs = PRESET_PACKAGES[preset] ?? []
  return dirs.map((dir) => ({ dir, ...WORKSPACE_PACKAGES[dir] }))
}

// Substrings that identify a stale dev process owned by this repo. Matched
// against the full command line; the runner itself is excluded by PID.
const STALE_PATTERNS = [
  'src/node/server.ts',
  'next-server (v',
  'next/dist/bin/next dev',
  '.next/dev/build/postcss.js',
  'wrangler dev',
  'tsup src/index.ts',
  'tsup --watch',
]

function usage(exit = 1) {
  console.error(`usage: node scripts/dev.mjs <${Object.keys(PRESETS).join('|')}|cleanup|${Object.keys(SERVICES).join('|')}>`)
  process.exit(exit)
}

function canConnect(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function clearStaleNextLock() {
  if (!fs.existsSync(NEXT_LOCK)) return
  // The lock is only stale when nothing answers on the Next ports. When an
  // orphan is still alive we must NOT delete it — Next is right to refuse.
  const taken = await canConnect(3000)
  if (taken) return
  try {
    fs.rmSync(NEXT_LOCK, { force: true })
    console.log('[dev] removed stale web/.next/dev/lock (port 3000 free)')
  } catch (err) {
    console.warn(`[dev] could not remove stale Next lock: ${err.message}`)
  }
}

async function listProcesses() {
  // Portable enough for Linux/macOS: pid + ppid + full args.
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid,ppid,args'])
  const rows = []
  for (const line of stdout.split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  return rows
}

function collectTree(rootPids, all) {
  const byParent = new Map()
  for (const p of all) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, [])
    byParent.get(p.ppid).push(p.pid)
  }
  const seen = new Set()
  const stack = [...rootPids]
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of byParent.get(pid) ?? []) stack.push(child)
  }
  return seen
}

async function killTree(rootPids, signal) {
  let all
  try {
    all = await listProcesses()
  } catch {
    for (const pid of rootPids) {
      try {
        process.kill(pid, signal)
      } catch {}
    }
    return
  }
  // Never kill the runner itself or the shells that launched it — only the
  // service trees rooted at our direct children.
  const byPid = new Map(all.map((p) => [p.pid, p]))
  const doNotKill = new Set([process.pid])
  let ancestor = byPid.get(process.pid)?.ppid
  const ancestorGuard = new Set([process.pid])
  while (ancestor && !ancestorGuard.has(ancestor)) {
    ancestorGuard.add(ancestor)
    doNotKill.add(ancestor)
    ancestor = byPid.get(ancestor)?.ppid
  }
  const tree = collectTree(rootPids, all)
  for (const pid of doNotKill) tree.delete(pid)
  // Descendants first so parents can't respawn them mid-shutdown.
  const depth = new Map()
  const getDepth = (pid) => {
    if (depth.has(pid)) return depth.get(pid)
    let d = 0
    let cur = byPid.get(pid)
    const guard = new Set()
    while (cur && tree.has(cur.ppid) && !guard.has(cur.ppid)) {
      guard.add(cur.ppid)
      d += 1
      cur = byPid.get(cur.ppid)
    }
    depth.set(pid, d)
    return d
  }
  const ordered = [...tree].sort((a, b) => getDepth(b) - getDepth(a))
  for (const pid of ordered) {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

/* ── stale workspace builds ─────────────────────────────────────────────────
 *
 * Everything below is pure except `realFs` and `runBuild`, so the decisions are
 * testable without touching the disk (see scripts/dev.test.mjs).
 */

const IGNORED_SOURCE_SUFFIXES = ['~', '.swp', '.tmp']

/** Newest mtime under a source tree, and whether the tree has a source file. */
function newestSourceTime(dir, fs) {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  let newest = 0
  let found = false
  for (const file of fs.readdir(dir)) {
    if (!file.startsWith(prefix)) continue
    if (IGNORED_SOURCE_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue
    found = true
    newest = Math.max(newest, fs.mtime(file))
  }
  return { newest, found }
}

/**
 * Which packages must be rebuilt before the services start.
 *
 * A package is stale when its build output is missing, or older than any source
 * file. The source tree is scanned, not just the entrypoint: the rename that
 * broke the dashboard touched `sdk/src/errors.ts`, while `index.ts` re-exported
 * it unchanged.
 */
export function preflightWorkspaceBuilds(packages, fs = realFs) {
  const stale = []
  for (const pkg of packages) {
    if (pkg.hasBuild === false) continue
    const entry = path.join(REPO_ROOT, pkg.dir, 'dist', 'index.js')
    const source = newestSourceTime(path.join(REPO_ROOT, pkg.dir, 'src'), fs)
    if (!source.found) continue
    if (!fs.exists(entry)) {
      stale.push({ ...pkg, reason: 'missing' })
      continue
    }
    if (source.newest > fs.mtime(entry)) {
      stale.push({ ...pkg, reason: 'stale' })
    }
  }
  return stale
}

const realFs = {
  exists: (file) => fs.existsSync(file),
  mtime: (file) => fs.statSync(file).mtimeMs,
  readdir: (dir) => {
    const out = []
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue
          walk(full)
        } else {
          out.push(full)
        }
      }
    }
    walk(dir)
    return out
  },
}

/** `pnpm --filter <pkg> build`, streamed so a tsup error is visible. */
async function runBuild(entry) {
  console.log(`[dev] building ${entry.label} (its dist is out of date with src/)`)
  const child = spawn('pnpm', ['--filter', entry.filter, 'build'], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  })
  return await new Promise((resolve) => {
    child.on('error', () => resolve(1))
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/**
 * Build every stale package, or refuse to start.
 *
 * Refusing is deliberate: starting the dashboard against a stale build produces
 * a browser-side compile error that reads like a source bug, and a half-working
 * dev loop is worse than a clear stop.
 */
async function ensureWorkspaceBuilds(packages, options = {}) {
  const { fs: filesystem = realFs, build = runBuild } = options
  const stale = preflightWorkspaceBuilds(packages, filesystem)
  for (const entry of stale) {
    const code = await build(entry)
    if (code !== 0) {
      const names = stale.map((item) => item.filter).join(', ')
      throw new Error(
        `build failed for ${entry.filter} (${entry.reason}). The dashboard imports ` +
          `${names} from their built dist/, so it cannot start until they build. ` +
          `Run it yourself to see the error: pnpm --filter ${entry.filter} build`,
      )
    }
  }
}

async function cleanupStale() {
  let all
  try {
    all = await listProcesses()
  } catch (err) {
    console.error(`[dev] cleanup failed to list processes: ${err.message}`)
    process.exit(1)
  }
  const stale = all.filter(
    (p) => p.pid !== process.pid && STALE_PATTERNS.some((pat) => p.args.includes(pat)),
  )
  if (stale.length === 0) {
    console.log('[dev] no stale dev processes found')
  } else {
    console.log(`[dev] stopping ${stale.length} stale process(es):`)
    for (const p of stale) console.log(`[dev]   ${p.pid} ${p.args.slice(0, 160)}`)
    await killTree(stale.map((p) => p.pid), 'SIGTERM')
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const remaining = (await listProcesses())
        .filter((p) => stale.some((s) => s.pid === p.pid))
        .map((p) => p.pid)
      if (remaining.length) await killTree(remaining, 'SIGKILL')
    } catch {}
  }
  await clearStaleNextLock()
  for (const port of [8787, 8788, 3000]) {
    if (await canConnect(port)) {
      console.warn(`[dev] port ${port} still answers — a non-dev process may hold it (ss -tlnp | grep ${port})`)
    } else {
      console.log(`[dev] port ${port} free`)
    }
  }
}

function pipeWithPrefix(child, label) {
  for (const [stream, source] of [['stdout', 'stdout'], ['stderr', 'stderr']]) {
    let buf = ''
    child[source].on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) process[stream].write(`${label} ${line}\n`)
    })
    child[source].on('end', () => {
      if (buf.length) process[stream].write(`${label} ${buf}\n`)
    })
  }
}

export async function run(preset, options = {}) {
  const keys = options.services ?? PRESETS[preset] ?? (SERVICES[preset] ? [preset] : null)
  if (!keys) usage()

  const webSelected = keys.some((key) => key === 'web' || key === 'web:workers' || key === 'web:start')

  // Before the dashboard compiles anything: a stale dist makes Next report a
  // missing export as if the source were wrong. Runs for every preset that
  // starts the dashboard, including `start` (which runs `next build`).
  const packages = options.packages ?? packagesFor(preset)
  if (webSelected && packages.length > 0) {
    await ensureWorkspaceBuilds(packages, {
      ...(options.fs !== undefined ? { fs: options.fs } : {}),
      ...(options.runBuild !== undefined ? { build: options.runBuild } : {}),
    })
  }
  if (webSelected) await clearStaleNextLock()

  if (options.startServices !== undefined) {
    await options.startServices()
    return
  }

  const children = new Map() // key -> ChildProcess
  let shuttingDown = false
  let exitCode = 0

  const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    exitCode = code
    const pids = [...children.values()].map((c) => c.pid).filter(Boolean)
    if (pids.length === 0) {
      process.exit(exitCode)
      return
    }
    console.log(`[dev] ${signal} — stopping ${pids.length} service(s)…`)
    await killTree(pids, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM')
    setTimeout(async () => {
      const alive = [...children.values()].filter((c) => c.exitCode === null).map((c) => c.pid).filter(Boolean)
      if (alive.length) await killTree(alive, 'SIGKILL')
      process.exit(exitCode)
    }, GRACE_MS).unref?.()
    // Give graceful shutdown a moment, then exit even if streams linger.
    setTimeout(() => process.exit(exitCode), GRACE_MS + 1000).unref?.()
  }

  process.on('SIGINT', () => void shutdown('SIGINT', 130))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 143))

  for (const key of keys) {
    const svc = SERVICES[key]
    const child = spawn('pnpm', svc.args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    children.set(key, child)
    pipeWithPrefix(child, `${svc.label} |`)
    child.on('error', (err) => {
      console.error(`[dev] failed to start ${svc.label}: ${err.message}`)
      void shutdown('SIGTERM', 1)
    })
    child.on('exit', (code, signal) => {
      children.delete(key)
      if (shuttingDown) {
        if (children.size === 0) process.exit(exitCode)
        return
      }
      // A service exiting on its own (crash, EADDRINUSE, config error) should
      // take the rest down — otherwise the survivor holds its port and the
      // next restart looks "already in use".
      const reason = signal ? `signal ${signal}` : `exit ${code}`
      console.error(`[dev] ${svc.label} exited (${reason}) — stopping the rest`)
      void shutdown('SIGTERM', code ?? 1)
    })
  }
}

async function main(argv) {
  const arg = argv[2]
  if (!arg) usage()
  if (arg === 'cleanup' || arg === 'clean' || arg === '--cleanup') {
    await cleanupStale()
  } else if (arg === '-h' || arg === '--help' || arg === 'help') {
    usage(0)
  } else {
    await run(arg)
  }
}

// Only when executed, not when imported by scripts/dev.test.mjs — importing
// this module must not start services or print usage.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main(process.argv)
}
