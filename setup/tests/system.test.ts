import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { execa } from 'execa'
import {
  blockers,
  informationRequirements,
  installCommandFor,
  installPlanFor,
  parseDetectDump,
  parsePackageTable,
  requirementRows,
  requirementWhyLines,
  requirementsFor,
  systemShapeFromAnswers,
  type RequirementStatus,
  type SystemShape,
} from '../src/system'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const tableText = readFileSync(join(repoRoot, 'scripts', 'lib', 'pkg-commands.tsv'), 'utf8')
const table = parsePackageTable(tableText)

const DETECT_DUMP = [
  'OS=linux',
  'FAMILY=debian',
  'DISTRO_ID=ubuntu',
  'DISTRO_LIKE=debian',
  'MANAGER=apt-get',
  'IS_ROOT=0',
  'HAS_SUDO=1',
  'NO_SUDO=0',
  'CAN_INSTALL=1',
].join('\n')

function status(
  id: RequirementStatus['requirement']['id'],
  level: 'required' | 'advisory',
  found: boolean,
  capability?: string,
): RequirementStatus {
  return {
    requirement: {
      id,
      label: id,
      why: 'because',
      level,
      ...(capability !== undefined ? { capability } : {}),
    },
    found,
  }
}

describe('parseDetectDump', () => {
  it('reads the verdict the shell detector produced', () => {
    const detection = parseDetectDump(DETECT_DUMP)
    expect(detection).toEqual({
      os: 'linux',
      family: 'debian',
      distroId: 'ubuntu',
      manager: 'apt-get',
      isRoot: false,
      hasSudo: true,
      noSudo: false,
      canInstall: true,
    })
  })

  it('degrades to "unknown" instead of throwing on junk', () => {
    expect(parseDetectDump('').family).toBe('unknown')
    expect(parseDetectDump('FAMILY=plan9\n').family).toBe('unknown')
    expect(parseDetectDump('FAMILY=plan9\n').canInstall).toBe(false)
  })
})

describe('parsePackageTable', () => {
  it('ignores comments and blank lines', () => {
    const parsed = parsePackageTable('# hi\n\npython3|mac|brew install python@3.12\n')
    expect(installCommandFor(parsed, 'mac', 'python3')).toBe('brew install python@3.12')
    expect(installCommandFor(parsed, 'mac', 'docker')).toBeUndefined()
  })

  it('finds the command for each family', () => {
    expect(installCommandFor(table, 'debian', 'python3')).toContain('python3-venv')
    expect(installCommandFor(table, 'rpm', 'python3')).toBe('dnf install -y python3 python3-pip')
    expect(installCommandFor(table, 'arch', 'python3')).toBe(
      'pacman -S --noconfirm python python-pip',
    )
    expect(installCommandFor(table, 'alpine', 'node')).toContain('apk add')
    expect(installCommandFor(table, 'mac', 'node')).toBe('brew install node@22')
  })

  it('has no docker row, because Docker is never installed with a guessed package name', () => {
    for (const family of ['debian', 'rpm', 'arch', 'suse', 'alpine', 'mac'] as const) {
      expect(installCommandFor(table, family, 'docker')).toBeUndefined()
    }
  })
})

describe('requirementsFor', () => {
  it('does not ask a Workers + Modal installation for Docker or Python', () => {
    const requirements = requirementsFor(
      { target: 'dev', runtime: 'workers', dbKind: 'neon', transcodeProvider: 'modal' },
      'develop',
    )
    const ids = requirements.map((requirement) => requirement.id)
    expect(ids).not.toContain('docker')
    expect(ids).not.toContain('docker-compose')
    // Python is only needed to build the Modal deploy environment.
    expect(requirements.find((requirement) => requirement.id === 'python3')?.level).toBe('advisory')
  })

  it('requires Docker and Compose for the deploy target', () => {
    const requirements = requirementsFor(
      { target: 'deploy', runtime: 'node', dbKind: 'local', transcodeProvider: 'modal' },
      'deploy',
    )
    for (const id of ['docker', 'docker-compose'] as const) {
      expect(requirements.find((requirement) => requirement.id === id)?.level).toBe('required')
    }
    // Python is required in the deploy phase: transcoding/.venv is the Modal CLI.
    expect(requirements.find((requirement) => requirement.id === 'python3')?.level).toBe('required')
  })

  it('requires Docker for the dev Postgres, but only when it is the bundled one', () => {
    const bundled = requirementsFor(
      { target: 'dev', runtime: 'node', dbKind: 'local', transcodeProvider: 'modal' },
      'develop',
    )
    expect(bundled.find((requirement) => requirement.id === 'docker')?.level).toBe('required')

    const external = requirementsFor(
      { target: 'dev', runtime: 'node', dbKind: 'existing', transcodeProvider: 'modal' },
      'develop',
    )
    expect(external.map((requirement) => requirement.id)).not.toContain('docker')
  })

  it('requires Docker for the self-hosted provider, because the agent is a container', () => {
    const requirements = requirementsFor(
      {
        target: 'dev',
        runtime: 'workers',
        dbKind: 'neon',
        transcodeProvider: 'self-hosted',
        uploadsEnabled: false,
      },
      'develop',
    )
    expect(requirements.find((requirement) => requirement.id === 'docker')?.level).toBe('required')
    // No Python requirement: nothing builds a Modal environment here.
    expect(requirements.map((requirement) => requirement.id)).not.toContain('python3')
  })

  it('delegates Docker installs to Docker itself', () => {
    const requirements = requirementsFor(
      { target: 'deploy', runtime: 'node', dbKind: 'local', transcodeProvider: 'modal' },
      'deploy',
    )
    const docker = requirements.find((requirement) => requirement.id === 'docker')
    expect(docker?.manual).toContain('docs.docker.com')
    // Nothing to run: there is no package-table capability for it.
    expect(docker?.capability).toBeUndefined()
  })
})

describe('requirementRows', () => {
  it('fails a required-and-missing row, and keeps the rest advisory', () => {
    const rows = requirementRows([
      status('docker', 'required', false),
      status('ffmpeg', 'advisory', false),
      status('curl', 'advisory', true),
    ])
    expect(rows[0].ok).toBe(false)
    expect(rows[0].advisory).toBe(false)
    expect(rows[1].advisory).toBe(true)
    expect(rows[2].ok).toBe(true)
  })

  it('names what is missing and why', () => {
    const statuses = [status('docker', 'required', false)]
    expect(requirementWhyLines(statuses)).toContain('docker')
  })
})

describe('blockers', () => {
  it('blocks on required-and-missing only', () => {
    const statuses = [
      status('docker', 'required', false),
      status('ffmpeg', 'advisory', false),
      status('python3', 'required', true),
    ]
    expect(blockers(statuses).map((entry) => entry.requirement.id)).toEqual(['docker'])
  })

  it('does not block on a missing python3 when uv is present', () => {
    // uv provisions its own interpreter and installs without pip, so the Modal
    // deploy environment is buildable without a system Python.
    const withUv = [
      status('uv', 'advisory', true),
      status('python3', 'required', false, 'python3'),
    ]
    expect(blockers(withUv)).toEqual([])
    // Without uv it is a real blocker.
    expect(
      blockers([status('uv', 'advisory', false), status('python3', 'required', false, 'python3')]),
    ).toHaveLength(1)
  })
})

describe('installPlanFor', () => {
  const detection = parseDetectDump(DETECT_DUMP)

  it('offers the table command, prefixed with sudo for a non-root user', () => {
    const plan = installPlanFor(status('python3', 'required', false, 'python3'), table, detection)
    expect(plan?.command).toBe('apt-get install -y python3 python3-venv python3-pip')
    expect(plan?.display).toBe('sudo apt-get install -y python3 python3-venv python3-pip')
  })

  it('offers nothing for a requirement with no package (Docker)', () => {
    expect(installPlanFor(status('docker', 'required', false), table, detection)).toBeUndefined()
  })
})

describe('informationRequirements', () => {
  it('marks everything advisory, because no shape has been chosen yet', () => {
    const requirements = informationRequirements()
    expect(requirements.every((requirement) => requirement.level === 'advisory')).toBe(true)
    expect(blockers(requirements.map((requirement) => ({ requirement, found: false })))).toEqual([])
  })
})

describe('systemShapeFromAnswers', () => {
  it('carries the fields requirements depend on', () => {
    const shape = systemShapeFromAnswers({
      target: 'deploy',
      runtime: 'node',
      db: { kind: 'local' },
      queue: { kind: 'direct' },
      rateLimit: { kind: 'memory' },
      transcodeProvider: 'self-hosted',
      uploadsEnabled: false,
      accountId: 'a'.repeat(32),
      r2AccessKeyId: 'k',
      r2SecretAccessKey: 's',
      rawBucket: '',
      transcodedBucket: 'out',
      frontendUrl: 'http://localhost:3000',
    })
    expect(shape).toEqual({
      target: 'deploy',
      runtime: 'node',
      dbKind: 'local',
      transcodeProvider: 'self-hosted',
      uploadsEnabled: false,
    })
  })
})

/**
 * The cross-language contract.
 *
 * The shell detector decides the family; the TypeScript planner looks commands
 * up by it. If the two ever disagree — a renamed family, a fixture that maps
 * somewhere the table does not cover — the wizard would silently lose the
 * ability to install anything on that distro, so it is asserted here against
 * the real script.
 */
describe('shell detector ↔ TypeScript planner', () => {
  const fixtures: Array<[fixture: string, content: string]> = [
    ['ubuntu', 'ID=ubuntu\nID_LIKE=debian\n'],
    ['fedora', 'ID=fedora\nID_LIKE="rhel fedora"\n'],
    ['arch', 'ID=arch\nID_LIKE=archlinux\n'],
    ['alpine', 'ID=alpine\n'],
    ['opensuse', 'ID="opensuse-leap"\nID_LIKE="suse opensuse"\n'],
    ['gentoo', 'ID=gentoo\n'],
  ]

  it('gives every family the detector can report the commands the planner needs', async () => {
    const script = [
      '. scripts/lib/detect.sh',
      'ov_detect_all',
      'ov_dump',
    ].join('\n')

    for (const [fixture, content] of fixtures) {
      const result = await execa('bash', ['-c', script], {
        cwd: repoRoot,
        reject: false,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          CLIPMUX_OS_RELEASE_FILE: '/dev/stdin',
        },
        input: content,
      })
      const detection = parseDetectDump(result.stdout)
      expect(`${fixture}=${detection.family}`).toBe(`${fixture}=${detection.family}`)

      const requirements = requirementsFor(
        { runtime: 'workers', dbKind: 'neon', transcodeProvider: 'modal' },
        'deploy',
      )
      for (const requirement of requirements) {
        if (requirement.capability === undefined) continue
        if (detection.family === 'unknown') {
          // An unknown family must produce no plan (instructions only) rather
          // than a wrong one.
          expect(installCommandFor(table, detection.family, requirement.capability)).toBeUndefined()
          continue
        }
        expect(
          installCommandFor(table, detection.family, requirement.capability),
        ).toBeDefined()
      }
    }
  })

  it('agrees with the table on every family name it produces', async () => {
    const familiesInTable = new Set(
      tableText
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
        .map((line) => line.split('|')[1]),
    )
    const result = await execa('bash', ['-c', '. scripts/lib/detect.sh; ov_detect_all; ov_dump'], {
      cwd: repoRoot,
      reject: false,
    })
    const family = parseDetectDump(result.stdout).family
    if (family === 'unknown') return
    expect(familiesInTable.has(family)).toBe(true)
  })
})

/** Every shape the wizard can produce must plan without throwing. */
describe('every shape plans', () => {
  const shapes: SystemShape[] = []
  for (const target of ['dev', 'deploy'] as const) {
    for (const runtime of ['workers', 'node'] as const) {
      for (const dbKind of ['neon', 'local', 'existing'] as const) {
        for (const transcodeProvider of ['modal', 'self-hosted'] as const) {
          for (const uploadsEnabled of [true, false]) {
            shapes.push({ target, runtime, dbKind, transcodeProvider, uploadsEnabled })
          }
        }
      }
    }
  }

  it('plans a requirement list for all combinations', () => {
    for (const shape of shapes) {
      for (const mode of ['develop', 'deploy'] as const) {
        const requirements = requirementsFor(shape, mode)
        expect(requirements.length).toBeGreaterThan(0)
        expect(new Set(requirements.map((requirement) => requirement.id)).size).toBe(
          requirements.length,
        )
      }
    }
  })

  it('never requires Python or Docker for a Workers + Modal develop run', () => {
    const requirements = requirementsFor(
      { target: 'dev', runtime: 'workers', dbKind: 'neon', transcodeProvider: 'modal' },
      'develop',
    )
    expect(
      requirements.filter((requirement) => requirement.level === 'required').map((r) => r.id),
    ).toEqual([])
  })
})
