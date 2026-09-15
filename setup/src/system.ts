/**
 * What this machine needs, and where the install commands come from.
 *
 * Detection itself lives in `scripts/lib/detect.sh` — the launcher has to know
 * the OS family before any Node exists, so that is the one place it can live,
 * and this module consumes its verdict (`--dump`) rather than re-deriving it.
 * Package commands live in `scripts/lib/pkg-commands.tsv`, read by both sides:
 * one table, two readers, so they cannot drift.
 *
 * Everything in this file is pure: parsing, planning and row rendering. The
 * probing and the running live in probe.ts / preflight.ts.
 */

import type { CheckRow } from './verify'
import type { ConfigTarget, DbKind, RuntimeKind, WizardAnswers } from './types'

export type OsFamily = 'debian' | 'rpm' | 'arch' | 'suse' | 'alpine' | 'mac' | 'unknown'

export interface PlatformDetection {
  os: string
  family: OsFamily
  distroId: string
  manager: string
  isRoot: boolean
  hasSudo: boolean
  noSudo: boolean
  /** Root or passwordless sudo, and not forbidden by OPENVOD_NO_SUDO. */
  canInstall: boolean
}

const EMPTY_DETECTION: PlatformDetection = {
  os: 'unknown',
  family: 'unknown',
  distroId: '',
  manager: '',
  isRoot: false,
  hasSudo: false,
  noSudo: false,
  canInstall: false,
}

const FAMILIES: readonly OsFamily[] = ['debian', 'rpm', 'arch', 'suse', 'alpine', 'mac', 'unknown']

function asBool(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

/** Parse `scripts/lib/detect.sh --dump` output. Unknown keys are ignored. */
export function parseDetectDump(text: string): PlatformDetection {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  if (values.size === 0) return { ...EMPTY_DETECTION }

  const familyRaw = values.get('FAMILY') ?? 'unknown'
  const family = (FAMILIES as readonly string[]).includes(familyRaw)
    ? (familyRaw as OsFamily)
    : 'unknown'

  return {
    os: values.get('OS') ?? 'unknown',
    family,
    distroId: values.get('DISTRO_ID') ?? '',
    manager: values.get('MANAGER') ?? '',
    isRoot: asBool(values.get('IS_ROOT')),
    hasSudo: asBool(values.get('HAS_SUDO')),
    noSudo: asBool(values.get('NO_SUDO')),
    canInstall: asBool(values.get('CAN_INSTALL')),
  }
}

/** capability|family|command rows, keyed `capability|family`. */
export type PackageTable = ReadonlyMap<string, string>

export function packageTableKey(capability: string, family: string): string {
  return `${capability}|${family}`
}

export function parsePackageTable(text: string): PackageTable {
  const table = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split('|')
    if (parts.length < 3) continue
    const capability = parts[0].trim()
    const family = parts[1].trim()
    const command = parts.slice(2).join('|').trim()
    if (capability === '' || family === '' || command === '') continue
    table.set(packageTableKey(capability, family), command)
  }
  return table
}

/** The install command for a capability on this family, or undefined. */
export function installCommandFor(
  table: PackageTable,
  family: OsFamily,
  capability: string,
): string | undefined {
  return table.get(packageTableKey(capability, family))
}

/** How the user would run the command themselves (root needs no `sudo`). */
export function displayCommand(command: string, isRoot: boolean): string {
  return isRoot ? command : `sudo ${command}`
}

export type RequirementId =
  | 'curl'
  | 'git'
  | 'node'
  | 'python3'
  | 'uv'
  | 'docker'
  | 'docker-compose'
  | 'ffmpeg'

export type RequirementLevel = 'required' | 'advisory'

export interface Requirement {
  id: RequirementId
  label: string
  /** Why it is needed, in one line. */
  why: string
  level: RequirementLevel
  /** Package-table capability when we are allowed to install it. */
  capability?: string
  /** What to do when we are not: a URL, or a command we refuse to run. */
  manual?: string
}

/** Docker's own installers, per platform — the only reliable cross-distro path. */
export const DOCKER_INSTALL_HINT =
  'https://docs.docker.com/engine/install/ (or: curl -fsSL https://get.docker.com | sh)'
export const DOCKER_DESKTOP_HINT = 'https://docs.docker.com/desktop/ (or: brew install --cask docker)'

/**
 * The part of the configuration that decides system requirements.
 *
 * A shape rather than full answers on purpose: requirements are planned right
 * after the choices, before any credential exists.
 */
export interface SystemShape {
  target?: ConfigTarget
  runtime: RuntimeKind
  dbKind?: DbKind
  transcodeProvider?: 'modal' | 'self-hosted'
  uploadsEnabled?: boolean
}

export function systemShapeFromAnswers(answers: WizardAnswers): SystemShape {
  return {
    ...(answers.target !== undefined ? { target: answers.target } : {}),
    runtime: answers.runtime,
    dbKind: answers.db?.kind,
    ...(answers.transcodeProvider !== undefined
      ? { transcodeProvider: answers.transcodeProvider }
      : {}),
    ...(answers.uploadsEnabled !== undefined ? { uploadsEnabled: answers.uploadsEnabled } : {}),
  }
}

/**
 * What the chosen shape implies for this machine.
 *
 * `mode` says which phase is asking: `develop` plans for `pnpm dev`, `deploy`
 * for the provision & deploy run. The same requirement can be advisory in one
 * and required in the other — python3 is only in the way of a Modal deploy, and
 * Docker is only in the way of a Compose stack.
 */
export function requirementsFor(
  shape: SystemShape,
  mode: 'develop' | 'deploy',
): Requirement[] {
  const target = shape.target ?? 'dev'
  const provider = shape.transcodeProvider === 'self-hosted' ? 'self-hosted' : 'modal'
  const requirements: Requirement[] = []

  const dockerHint = DOCKER_INSTALL_HINT

  // ── Always: the tools the front door itself uses ────────────────────────
  requirements.push({
    id: 'curl',
    label: 'curl',
    why: 'the launcher downloads nvm, pnpm and installers with it',
    level: 'advisory',
    capability: 'curl',
  })
  requirements.push({
    id: 'git',
    label: 'git',
    why: 'cloning and updating this repository',
    level: 'advisory',
    capability: 'git',
  })

  // ── Docker: the Compose stack and the self-hosted agent ─────────────────
  const wantsCompose = target === 'deploy'
  const wantsLocalInfra =
    target === 'dev' && shape.runtime === 'node' && shape.dbKind === 'local'
  const wantsAgent = provider === 'self-hosted'
  if (wantsCompose || wantsLocalInfra || wantsAgent) {
    const why = wantsAgent
      ? 'the self-hosted transcoder agent runs as a container (it ships its own FFmpeg)'
      : wantsCompose
        ? 'the deploy target runs the Docker Compose stack'
        : '`pnpm dev:infra` starts the dev Postgres and Redis in containers'
    const level: RequirementLevel =
      wantsAgent || wantsCompose || (wantsLocalInfra && mode === 'develop') ? 'required' : 'advisory'
    requirements.push({
      id: 'docker',
      label: 'Docker',
      why,
      level,
      manual: dockerHint,
    })
    requirements.push({
      id: 'docker-compose',
      label: 'Docker Compose (v2 plugin)',
      why: '`docker compose` drives every container OpenVOD starts',
      level,
      manual: dockerHint,
    })
  }
  // No row at all when nothing in this shape uses Docker: a "✓ Docker — not
  // needed for this shape" line is noise, and an advisory "○ Docker" on a
  // Workers install reads like something is missing.

  // ── Python: building the Modal deploy environment ──────────────────────
  if (provider === 'modal') {
    requirements.push({
      id: 'uv',
      label: 'uv',
      why: 'optional but preferred: it builds transcoding/.venv and can fetch its own Python',
      level: 'advisory',
    })
    requirements.push({
      id: 'python3',
      label: 'Python 3 (with venv + pip)',
      why: 'builds transcoding/.venv, which is the Modal CLI this wizard drives',
      level: mode === 'deploy' ? 'required' : 'advisory',
      capability: 'python3',
      manual: 'https://www.python.org/downloads/',
    })
  }

  // ── Informational: host FFmpeg ─────────────────────────────────────────
  requirements.push({
    id: 'ffmpeg',
    label: 'FFmpeg on this machine',
    why: 'only for running the transcoder agent natively — the agent image builds its own',
    level: 'advisory',
    capability: 'ffmpeg',
  })

  return requirements
}

/**
 * The tools worth reporting when no configuration exists yet.
 *
 * `--doctor` on a fresh clone must still answer "what does this machine have?",
 * while being explicit that nothing is *required* until a shape is chosen —
 * which is the opposite of claiming a provider requirement the user never
 * selected.
 */
export function informationRequirements(): Requirement[] {
  return [
    { id: 'curl', label: 'curl', why: 'the launcher downloads installers with it', level: 'advisory', capability: 'curl' },
    { id: 'git', label: 'git', why: 'cloning and updating this repository', level: 'advisory', capability: 'git' },
    { id: 'node', label: 'Node', why: 'the wizard and the workspace need it', level: 'advisory' },
    { id: 'python3', label: 'Python 3', why: 'needed only for the Modal deploy path', level: 'advisory', capability: 'python3' },
    { id: 'uv', label: 'uv', why: 'optional: builds transcoding/.venv without a system Python', level: 'advisory' },
    { id: 'docker', label: 'Docker', why: 'needed for the Compose stack, local infra, or local transcoding', level: 'advisory', manual: DOCKER_INSTALL_HINT },
    { id: 'ffmpeg', label: 'FFmpeg on this machine', why: 'only for running the transcoder agent natively', level: 'advisory', capability: 'ffmpeg' },
  ]
}

export interface RequirementStatus {
  requirement: Requirement
  found: boolean
  /** Version, or the reason it is missing. Never a secret. */
  detail?: string
}

/**
 * Render the plan as the check rows the wizard already knows how to print.
 *
 * A required-and-missing row is a failure (✗); everything else is advisory (○)
 * so a machine that simply has no Docker does not look broken.
 */
export function requirementRows(statuses: readonly RequirementStatus[]): CheckRow[] {
  return statuses.map(({ requirement, found, detail }) => {
    const suffix = detail !== undefined && detail !== '' ? ` — ${detail}` : ''
    return {
      ok: found,
      advisory: requirement.level !== 'required' || found,
      text: `${requirement.label}${suffix}`,
      key: requirement.id,
    }
  })
}

/** Required requirements that are missing — the ones that must block a run. */
export function blockers(statuses: readonly RequirementStatus[]): RequirementStatus[] {
  return statuses.filter(({ requirement, found }) => requirement.level === 'required' && !found)
}

/** One line per requirement explaining what it is for. */
export function requirementWhyLines(statuses: readonly RequirementStatus[]): string {
  return statuses
    .filter(({ found }) => !found)
    .map(({ requirement }) => `· ${requirement.label}: ${requirement.why}`)
    .join('\n')
}

/** The install command to offer for a missing requirement, if there is one. */
export function installPlanFor(
  status: RequirementStatus,
  table: PackageTable,
  detection: PlatformDetection,
): { command: string; display: string } | undefined {
  const capability = status.requirement.capability
  if (capability === undefined) return undefined
  const command = installCommandFor(table, detection.family, capability)
  if (command === undefined) return undefined
  return { command, display: displayCommand(command, detection.isRoot) }
}
