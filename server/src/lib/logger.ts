/**
 * Structured logger.
 *
 * The level is a constructor argument, not an ambient read. On Workers
 * `process.env.NODE_ENV` is statically replaced at build time rather than read at
 * runtime, so a module-scope level was frozen for the isolate's life; the
 * composition root now resolves it once from the same configuration everything
 * else uses, and injects it.
 */

import type { LogLevel } from './config'

type LogFields = Record<string, unknown>

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export type Logger = {
  debug: (fields: LogFields, message?: string) => void
  info: (fields: LogFields, message?: string) => void
  warn: (fields: LogFields, message?: string) => void
  error: (fields: LogFields, message?: string) => void
  child: (bindings: LogFields) => Logger
}

export type LoggerOptions = {
  level: LogLevel
  service?: string
}

export function createLogger(options: LoggerOptions): Logger {
  const { level: configuredLevel, service = 'vod-api' } = options

  const shouldLog = (level: LogLevel): boolean =>
    levelPriority[level] >= levelPriority[configuredLevel]

  const write = (level: LogLevel, fields: LogFields, message?: string): void => {
    if (!shouldLog(level)) return

    const payload = {
      level,
      service,
      ...fields,
      ...(message ? { msg: message } : {}),
    }

    const line = JSON.stringify(payload)
    if (level === 'error') {
      console.error(line)
      return
    }
    if (level === 'warn') {
      console.warn(line)
      return
    }
    console.log(line)
  }

  const build = (bindings: LogFields = {}): Logger => ({
    debug: (fields, message) => write('debug', { ...bindings, ...fields }, message),
    info: (fields, message) => write('info', { ...bindings, ...fields }, message),
    warn: (fields, message) => write('warn', { ...bindings, ...fields }, message),
    error: (fields, message) => write('error', { ...bindings, ...fields }, message),
    child: (childBindings) => build({ ...bindings, ...childBindings }),
  })

  return build()
}
