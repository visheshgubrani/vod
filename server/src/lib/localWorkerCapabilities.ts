/** Capability validation and secret-free projections for the deployment worker. */

export type LocalWorkerCapabilities = {
  encoders?: string[]
  ffmpeg?: string
  shaka?: string
  cpuCores?: number
  memoryBytes?: number
  scratchFreeBytes?: number
  transcription?: boolean
  chapters?: boolean
  hwaccels?: string[]
  probedAt?: number
}

export const LOCAL_WORKER_LIVENESS_WINDOW_MS = 90_000

export function isLocalWorkerLive(lastSeenAt: Date | null, now = Date.now()): boolean {
  return Boolean(lastSeenAt && now - lastSeenAt.getTime() <= LOCAL_WORKER_LIVENESS_WINDOW_MS)
}

export type PublicCapabilitiesInput = {
  modalConfigured: boolean
  localConfigured: boolean
  localEnabled: boolean
  localWorkerOnline: boolean
  localImportConfigured: boolean
  rawBucket: string | null
  transcodedBucket: string | null
  hasStorageCredentials: boolean
  defaultProvider: string
  aiEnabled: boolean
  workerCapabilities?: Record<string, unknown> | null
}

export type PublicCapabilities = {
  uploads: boolean
  localImport: boolean
  providers: string[]
  defaultProvider: string
  subtitles: boolean
  chapters: boolean
  localWorker: { online: boolean }
}

export function buildPublicCapabilities(input: PublicCapabilitiesInput): PublicCapabilities {
  const localAvailable = input.localConfigured && input.localEnabled && input.localWorkerOnline
  const providers: string[] = []
  if (input.modalConfigured) providers.push('modal')
  if (input.localConfigured && input.localEnabled) providers.push('local')
  const capabilities = input.workerCapabilities ?? {}
  return {
    providers,
    defaultProvider: input.defaultProvider,
    uploads: Boolean(input.rawBucket && input.hasStorageCredentials && (input.modalConfigured || localAvailable)),
    localImport: Boolean(
      input.localEnabled && input.localWorkerOnline && input.localImportConfigured &&
      input.hasStorageCredentials && input.transcodedBucket,
    ),
    subtitles: input.aiEnabled || capabilities.transcription === true,
    chapters: input.aiEnabled || capabilities.chapters === true,
    localWorker: { online: input.localWorkerOnline },
  }
}

export function validateCapabilities(
  value: unknown,
): { ok: true; value: LocalWorkerCapabilities } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: {} }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'capabilities must be an object' }
  }
  const raw = value as Record<string, unknown>
  const capabilities: LocalWorkerCapabilities = {}
  for (const key of ['encoders', 'hwaccels'] as const) {
    if (raw[key] === undefined) continue
    if (!Array.isArray(raw[key]) || raw[key].some((entry) => typeof entry !== 'string')) {
      return { ok: false, reason: `capabilities.${key} must be an array of strings` }
    }
    capabilities[key] = raw[key] as string[]
  }
  for (const key of ['ffmpeg', 'shaka'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      return { ok: false, reason: `capabilities.${key} must be a string` }
    }
    if (typeof raw[key] === 'string') capabilities[key] = raw[key] as string
  }
  for (const key of ['cpuCores', 'memoryBytes', 'scratchFreeBytes', 'probedAt'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
      return { ok: false, reason: `capabilities.${key} must be a finite number` }
    }
    capabilities[key] = raw[key] as number
  }
  for (const key of ['transcription', 'chapters'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') {
      return { ok: false, reason: `capabilities.${key} must be a boolean` }
    }
    capabilities[key] = raw[key] as boolean
  }
  return { ok: true, value: capabilities }
}
