type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogFields = Record<string, unknown>

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const configuredLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ||
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug')

function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] >= levelPriority[configuredLevel]
}

function write(level: LogLevel, fields: LogFields, message?: string) {
  if (!shouldLog(level)) return

  const payload = {
    level,
    service: 'vod-api',
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

export type Logger = {
  debug: (fields: LogFields, message?: string) => void
  info: (fields: LogFields, message?: string) => void
  warn: (fields: LogFields, message?: string) => void
  error: (fields: LogFields, message?: string) => void
  child: (bindings: LogFields) => Logger
}

function createLogger(bindings: LogFields = {}): Logger {
  return {
    debug: (fields, message) => write('debug', { ...bindings, ...fields }, message),
    info: (fields, message) => write('info', { ...bindings, ...fields }, message),
    warn: (fields, message) => write('warn', { ...bindings, ...fields }, message),
    error: (fields, message) => write('error', { ...bindings, ...fields }, message),
    child: (childBindings) => createLogger({ ...bindings, ...childBindings }),
  }
}

export const logger = createLogger()
