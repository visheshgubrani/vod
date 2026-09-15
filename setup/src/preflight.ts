/**
 * The requirements phase: what this machine needs for the choices just made,
 * what it has, and what we are allowed to install.
 *
 * Order matters and is the point: requirements are planned from the *choices*,
 * so a Workers deployment is never told to install Docker, and a local-only
 * installation is never told to install Python for a Modal deploy it will not
 * run. Nothing here mutates the repository; the only side effect is a package
 * install, and only when the run is interactive, the user confirms, and the
 * machine allows escalation (root or passwordless sudo).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCapture } from './runners'
import {
  blockers,
  informationRequirements,
  installPlanFor,
  parseDetectDump,
  parsePackageTable,
  requirementRows,
  requirementWhyLines,
  requirementsFor,
  type PackageTable,
  type PlatformDetection,
  type RequirementStatus,
  type SystemShape,
} from './system'
import { probeRequirements } from './probe'
import { runInstallCommand } from './install'
import { askConfirm, logInfo, logStep, logSuccess, logWarn, note, printCheckRows } from './ui'

export interface PreflightInput {
  root: string
  /** The chosen shape; omit for a report of what the machine has (--doctor). */
  shape?: SystemShape
  mode: 'develop' | 'deploy'
  /** Report only: never install (--doctor, headless runs, deploy-phase re-check). */
  reportOnly: boolean
}

export interface PreflightReport {
  detection: PlatformDetection
  table: PackageTable
  statuses: RequirementStatus[]
  blockers: RequirementStatus[]
  /** Labels of the requirements installed during this run. */
  installed: string[]
}

export function detectScriptPath(root: string): string {
  return join(root, 'scripts', 'lib', 'detect.sh')
}

export function packageTablePath(root: string): string {
  return join(root, 'scripts', 'lib', 'pkg-commands.tsv')
}

/** Read the platform verdict from the one detector. */
export async function detectPlatform(root: string): Promise<PlatformDetection> {
  const script = detectScriptPath(root)
  if (!existsSync(script)) {
    return parseDetectDump('')
  }
  const result = await runCapture(['bash', script, '--dump'], { cwd: root, timeoutMs: 30_000 })
  if (result.code !== 0) {
    return parseDetectDump('')
  }
  return parseDetectDump(result.stdout)
}

export function loadPackageTable(root: string): PackageTable {
  const path = packageTablePath(root)
  if (!existsSync(path)) return new Map()
  return parsePackageTable(readFileSync(path, 'utf8'))
}

function describePlatform(detection: PlatformDetection): string {
  const parts: string[] = []
  if (detection.distroId !== '') parts.push(detection.distroId)
  else if (detection.os !== 'unknown') parts.push(detection.os)
  parts.push(`family ${detection.family}`)
  if (detection.manager !== '') parts.push(detection.manager)
  if (detection.isRoot) parts.push('running as root')
  else if (detection.canInstall) parts.push('passwordless sudo')
  else if (detection.noSudo) parts.push('elevation disabled (OPENVOD_NO_SUDO=1)')
  else parts.push('no root/passwordless sudo')
  return parts.join(' · ')
}

/**
 * Report, offer, install, re-probe.
 *
 * Returns the plan plus what is still missing, so the caller decides whether a
 * gap is fatal — this function never exits the process.
 */
export async function runPreflight(input: PreflightInput): Promise<PreflightReport> {
  const detection = await detectPlatform(input.root)
  const table = loadPackageTable(input.root)
  const requirements =
    input.shape === undefined
      ? informationRequirements()
      : requirementsFor(input.shape, input.mode)

  logStep(`Checking this machine (${describePlatform(detection)})`)
  let statuses = await probeRequirements(requirements)
  printCheckRows(requirementRows(statuses))

  const installed: string[] = []
  const missing = statuses.filter((status) => !status.found)
  if (missing.length > 0) {
    const why = requirementWhyLines(statuses)
    if (why !== '') note(why, 'What the missing pieces are for')
  }

  if (!input.reportOnly && input.shape !== undefined) {
    for (const status of missing) {
      const plan = installPlanFor(status, table, detection)
      if (plan === undefined) {
        const manual = status.requirement.manual
        if (manual !== undefined) {
          logInfo(`${status.requirement.label}: install it yourself — ${manual}`)
        }
        continue
      }
      if (!detection.canInstall) {
        // One policy, both languages: without root or passwordless sudo we print
        // the command and move on rather than asking for a password.
        logInfo(`${status.requirement.label}: run this yourself —  ${plan.display}`)
        continue
      }
      const confirmed = await askConfirm(
        `Install ${status.requirement.label} now?  (${plan.display})`,
        false,
      )
      if (!confirmed) {
        logInfo(`${status.requirement.label}: skipped —  ${plan.display}`)
        continue
      }
      const result = await runInstallCommand(plan.command, {
        cwd: input.root,
        isRoot: detection.isRoot,
      })
      if (result.ok) {
        installed.push(status.requirement.label)
      } else {
        logWarn(`${status.requirement.label}: ${result.message} — run this yourself: ${plan.display}`)
      }
    }

    if (installed.length > 0) {
      statuses = await probeRequirements(requirements)
      const fixed = statuses.filter(
        (status) => status.found && installed.some((label) => status.requirement.label === label),
      )
      for (const status of fixed) logSuccess(`${status.requirement.label} is available now`)
      printCheckRows(requirementRows(statuses))
    }
  }

  return {
    detection,
    table,
    statuses,
    blockers: blockers(statuses),
    installed,
  }
}
