/**
 * Thin wrappers around @clack/prompts, chalk, and ora so the rest of the
 * wizard never touches clack's cancel protocol, ANSI, or spinner internals.
 * Ctrl+C anywhere becomes CancelledError. Long captured subprocesses use
 * ora; interactive children (wrangler login, modal setup) inherit stdio
 * and must not start a spinner.
 */

import * as clack from '@clack/prompts'
import chalk from 'chalk'
import ora from 'ora'
import type { CheckRow } from './verify'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export const color = {
  brand: (text: string) => chalk.bold.cyan(text),
  muted: (text: string) => chalk.dim(text),
  ok: (text: string) => chalk.green(text),
  fail: (text: string) => chalk.red(text),
  warn: (text: string) => chalk.yellow(text),
  cmd: (text: string) => chalk.cyan(text),
}

export function intro(subtitle = 'BYOK bootstrap'): void {
  clack.intro(`${chalk.bold.cyan('OpenVOD')}  ${chalk.dim('·')}  ${chalk.dim(subtitle)}`)
}

export function outro(message: string): void {
  clack.outro(message)
}

export function note(body: string, title?: string): void {
  clack.note(body, title)
}

export function logInfo(message: string): void {
  clack.log.info(message)
}

export function logStep(message: string): void {
  clack.log.step(message)
}

export function logSuccess(message: string): void {
  clack.log.success(message)
}

export function logWarn(message: string): void {
  clack.log.warn(message)
}

export function logError(message: string): void {
  clack.log.error(message)
}

/** Headless/non-TTY error. Interactive runs go through clack.log.error. */
export function printError(message: string): void {
  if (isTty()) {
    clack.log.error(message)
    return
  }
  // eslint-disable-next-line no-console
  console.error(chalk.red(message))
}

export function printOk(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`${chalk.green('✓')} ${message}`)
}

export function formatCheckRow(row: CheckRow): string {
  if (row.ok) return `${chalk.green('✓')} ${row.text}`
  if (row.advisory) {
    return `${chalk.dim('○')} ${row.text}${chalk.dim(' — optional / advisory')}`
  }
  return `${chalk.red('✗')} ${row.text}${chalk.red(' — missing or placeholder')}`
}

export function printCheckRows(rows: CheckRow[]): void {
  for (const row of rows) {
    // eslint-disable-next-line no-console
    console.log(formatCheckRow(row))
  }
}

export function printHelp(): void {
  const flag = (name: string) => chalk.cyan(name)
  const cmd = (line: string) => chalk.dim(line)
  const lines = [
    `${chalk.bold.cyan('OpenVOD')} ${chalk.dim('bootstrap')} — BYOK environment wizard`,
    '',
    chalk.bold('Usage') + color.muted(' (run from anywhere inside the repo):'),
    `  ${cmd('./scripts/bootstrap.sh')}                        interactive configure (writes server/.dev.vars + delivery/.dev.vars)`,
    `  ${cmd('./scripts/bootstrap.sh')} ${flag('--force')}                regenerate; pre-existing keys the wizard does not manage are preserved`,
    `  ${cmd('./scripts/bootstrap.sh')} ${flag('--answers')} <file.json>  headless configure using a JSON answers file (no terminal`,
    '                                                needed; file paths are relative to the repo root)',
    `  ${cmd('./scripts/bootstrap.sh')} ${flag('--deploy')}               provision & deploy: Cloudflare login, R2 buckets/CORS, Modal secrets +`,
    '                                                pipeline, API + delivery deploys (uses existing .dev.vars when present)',
    `  ${cmd('./scripts/bootstrap.sh')} ${flag('--check')} [api-url]      lint .dev.vars without printing secrets (+ probe api/health/config)`,
    `  ${cmd('./scripts/bootstrap.sh')} ${flag('--help')}`,
    '',
    chalk.bold('Prefill flags') + color.muted(' (interactive mode only):') +
      ` ${flag('--runtime')} workers|compose ${flag('--db')} neon|local|existing`,
    `  ${flag('--queue')} direct|qstash ${flag('--ratelimit')} memory|upstash`,
    '',
    chalk.bold('Headless answers file') + color.muted(' (same shape the wizard collects interactively):'),
    chalk.dim('  {'),
    chalk.dim('    "runtime": "workers",             // "workers" | "compose"'),
    chalk.dim('    "db": { "kind": "neon", "url": "postgresql://…" },   // compose: "local" | { "kind":"existing", "url": "…" }'),
    chalk.dim('    "queue": { "kind": "direct" },    // or { "kind": "qstash", "token": "…" }'),
    chalk.dim('    "rateLimit": { "kind": "memory" }, // or { "kind": "upstash", "restUrl": "https://…", "token": "…" }'),
    chalk.dim('    "accountId": "…", "r2AccessKeyId": "…", "r2SecretAccessKey": "…",'),
    chalk.dim('    "rawBucket": "openvod-raw", "transcodedBucket": "openvod-transcoded",'),
    chalk.dim('    "frontendUrl": "http://localhost:3000", "groqApiKey": ""   // optional'),
    chalk.dim('  }'),
  ]
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))
}

export interface SelectOption<T extends string> {
  value: T
  label: string
  hint?: string
}

export async function askSelect<T extends string>(
  message: string,
  options: SelectOption<T>[],
  initialValue?: T,
): Promise<T> {
  // clack's Option<T> is a deferred conditional type over its generic, so
  // structural assignability cannot be proven statically; the double cast is
  // confined to this seam and our wrapper still types the public API.
  const clackOptions = options.map(
    ({ value, label, hint }) => ({ value, label, hint }),
  ) as never
  const result = await clack.select<T>({ message, options: clackOptions, initialValue })
  if (clack.isCancel(result)) throw new CancelledError()
  return result
}

export interface AskTextOptions {
  placeholder?: string
  initialValue?: string
  /** Returns an error message string when the value is invalid. */
  validate?: (value: string) => string | undefined
}

export async function askText(message: string, options: AskTextOptions = {}): Promise<string> {
  const result = await clack.text({
    message,
    placeholder: options.placeholder,
    initialValue: options.initialValue,
    validate: options.validate ? (value?: string) => options.validate?.(value ?? '') : undefined,
  })
  if (clack.isCancel(result)) throw new CancelledError()
  return (result ?? '').trim()
}

export async function askPassword(message: string): Promise<string> {
  const result = await clack.password({ message })
  if (clack.isCancel(result)) throw new CancelledError()
  return (result ?? '').trim()
}

export async function askConfirm(
  message: string,
  initialValue = true,
): Promise<boolean> {
  const result = await clack.confirm({ message, initialValue })
  if (clack.isCancel(result)) throw new CancelledError()
  return Boolean(result)
}

/** Run an async step behind an ora spinner with a success message. */
export async function withSpinner<T>(
  startMessage: string,
  work: () => Promise<T>,
  stopMessage?: string,
): Promise<T> {
  const spinner = ora({
    text: startMessage,
    color: 'cyan',
    isSilent: !isTty(),
    discardStdin: false,
  })
  spinner.start()
  try {
    const value = await work()
    spinner.succeed(stopMessage ?? startMessage)
    return value
  } catch (error) {
    spinner.fail(startMessage)
    throw error
  }
}

export function announceCancel(): void {
  clack.cancel('Cancelled — nothing was changed.')
}
