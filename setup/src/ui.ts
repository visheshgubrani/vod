/**
 * Thin wrappers around @clack/prompts so the rest of the wizard never touches
 * clack's symbol-based cancel protocol directly. Every user-facing prompt
 * funnels through here; Ctrl+C anywhere becomes CancelledError.
 */

import * as clack from '@clack/prompts'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function intro(title: string): void {
  clack.intro(title)
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

/** Run an async step behind a spinner with a success message. */
export async function withSpinner<T>(
  startMessage: string,
  work: () => Promise<T>,
  stopMessage?: string,
): Promise<T> {
  const spinner = clack.spinner()
  spinner.start(startMessage)
  try {
    const value = await work()
    spinner.stop(stopMessage ?? startMessage)
    return value
  } catch (error) {
    spinner.stop('failed')
    throw error
  }
}

export function announceCancel(): void {
  clack.cancel('Cancelled — nothing was changed.')
}
