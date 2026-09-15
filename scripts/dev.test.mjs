import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  PACKAGE_FILTERS,
  REPO_ROOT,
  preflightWorkspaceBuilds,
  run,
} from '../scripts/dev.mjs'

/**
 * `pnpm dev` starts the dashboard against the *built* output of the workspace
 * packages it imports. Those `dist/` directories are gitignored, so a clone, a
 * branch switch or a rename in `sdk/` leaves them stale — and the failure
 * surfaces as a Next compile error in the browser ("Export ClipMuxUploader
 * doesn't exist in target module"), long after the cause. These are the
 * decisions that catch it before the servers start.
 */

/** A repo-relative path, as the module will resolve it. */
const at = (relative) => join(REPO_ROOT, relative)

/** Injected filesystem: which files exist, and what they hold. */
function fakeFs(entries) {
  const times = new Map(Object.entries(entries).map(([file, time]) => [at(file), time]))
  return {
    exists: (file) => times.has(file),
    mtime: (file) => times.get(file),
    readdir: (dir) =>
      [...times.keys()].filter((file) => file.startsWith(`${dir}/`) && !file.startsWith(`${dir}/dist/`)),
  }
}

const PKG = { dir: 'sdk', filter: '@clipmux/uploader', label: 'sdk' }

describe('preflightWorkspaceBuilds', () => {
  it('rebuilds a package whose dist is older than its source', () => {
    const fs = fakeFs({ 'sdk/src/index.ts': 100, 'sdk/dist/index.js': 50 })
    assert.deepEqual(preflightWorkspaceBuilds([PKG], fs), [{ ...PKG, reason: 'stale' }])
  })

  it('rebuilds a package with no dist at all', () => {
    const fs = fakeFs({ 'sdk/src/index.ts': 100 })
    assert.deepEqual(preflightWorkspaceBuilds([PKG], fs), [{ ...PKG, reason: 'missing' }])
  })

  it('leaves an up-to-date package alone', () => {
    const fs = fakeFs({ 'sdk/src/index.ts': 50, 'sdk/dist/index.js': 100 })
    assert.deepEqual(preflightWorkspaceBuilds([PKG], fs), [])
  })

  it('ignores a package that has no build script', () => {
    const fs = fakeFs({ 'sdk/src/index.ts': 100, 'sdk/dist/index.js': 50 })
    assert.deepEqual(preflightWorkspaceBuilds([{ ...PKG, hasBuild: false }], fs), [])
  })

  it('treats a stale nested source file as stale, not just the entry', () => {
    // The rename that broke this repository touched sdk/src/errors.ts, while
    // index.ts re-exported it unchanged.
    const fs = fakeFs({
      'sdk/src/index.ts': 10,
      'sdk/src/errors.ts': 900,
      'sdk/dist/index.js': 50,
    })
    assert.equal(preflightWorkspaceBuilds([PKG], fs)[0]?.reason, 'stale')
  })

  it('judges each package independently', () => {
    const fs = fakeFs({
      'sdk/src/index.ts': 100,
      'sdk/dist/index.js': 50,
      'player/src/index.ts': 10,
      'player/dist/index.js': 500,
    })
    assert.deepEqual(
      preflightWorkspaceBuilds(PACKAGE_FILTERS, fs).map((entry) => entry.dir),
      ['sdk'],
    )
  })

  it('ignores a package with no source tree', () => {
    const fs = fakeFs({ 'sdk/dist/index.js': 50 })
    assert.deepEqual(preflightWorkspaceBuilds([PKG], fs), [])
  })
})

describe('run', () => {
  it('refuses to start the dashboard against a package that will not build', async () => {
    const attempted = []
    const fs = fakeFs({ 'sdk/src/index.ts': 100, 'sdk/dist/index.js': 50 })
    await assert.rejects(
      run('dev', {
        packages: [PKG],
        fs,
        services: ['api', 'web'],
        runBuild: async (entry) => {
          attempted.push(entry.filter)
          return 1
        },
        startServices: async () => {},
      }),
      /@clipmux\/uploader/,
    )
    assert.deepEqual(attempted, ['@clipmux/uploader'])
  })

  it('builds the stale packages, then starts the services', async () => {
    const events = []
    const fs = fakeFs({
      'sdk/src/index.ts': 100,
      'sdk/dist/index.js': 50,
      'player/src/index.ts': 10,
      'player/dist/index.js': 500,
    })
    await run('dev', {
      packages: [PKG, { dir: 'player', filter: '@clipmux/player', label: 'player' }],
      fs,
      services: ['api', 'web'],
      runBuild: async (entry) => {
        events.push(`build:${entry.dir}`)
        return 0
      },
      startServices: async () => events.push('start'),
    })
    assert.deepEqual(events, ['build:sdk', 'start'])
  })

  it('starts without building anything when the packages are current', async () => {
    const events = []
    const fs = fakeFs({ 'sdk/src/index.ts': 10, 'sdk/dist/index.js': 500 })
    await run('dev', {
      packages: [PKG],
      fs,
      services: ['api', 'web'],
      runBuild: async () => {
        events.push('build')
        return 0
      },
      startServices: async () => events.push('start'),
    })
    assert.deepEqual(events, ['start'])
  })

  it('also preflights `start`, which runs `next build` against the same dist', async () => {
    const events = []
    const fs = fakeFs({ 'sdk/src/index.ts': 100, 'sdk/dist/index.js': 50 })
    await run('start', {
      packages: [PKG],
      fs,
      services: ['api:start', 'web:start'],
      runBuild: async () => {
        events.push('build')
        return 0
      },
      startServices: async () => events.push('start'),
    })
    assert.deepEqual(events, ['build', 'start'])
  })

  it('does not preflight a preset with no dashboard (delivery alone)', async () => {
    const events = []
    const fs = fakeFs({ 'sdk/src/index.ts': 100, 'sdk/dist/index.js': 50 })
    await run('delivery', {
      packages: [PKG],
      fs,
      runBuild: async () => {
        events.push('build')
        return 0
      },
      startServices: async () => events.push('start'),
    })
    assert.deepEqual(events, ['start'])
  })
})
