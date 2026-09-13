/**
 * Agent capability reporting and its two public projections.
 *
 * The plan requires capability reporting to be split, because one flat
 * "transcoding: true" answers a question nobody asked:
 *
 *   - **upload availability** — can a browser or SDK upload be processed at all?
 *     Requires a raw bucket *and* a processor that can read it.
 *   - **local-import availability** — can a file on the owner's machine be
 *     imported? Requires a paired, enabled, recently-seen agent. Needs no raw
 *     bucket at all.
 *   - **configured providers** — Modal, self-hosted, or both.
 *   - **optional enrichment** — subtitles, chapters; each independently on/off.
 *
 * And two audiences:
 *
 *   - `/health/config` is **public**. It must never leak paths, credentials or a
 *     detailed agent inventory: an unauthenticated caller learning that an
 *     organization runs three agents with specific hostnames is an information
 *     disclosure with no upside. So the public projection is booleans and
 *     counts.
 *   - the authenticated dashboard health is where agent connectivity and
 *     capacity belong.
 */

export type AgentCapabilities = {
  /** `cpu`, `nvenc`, `vaapi` — whichever the agent verified with a real encode. */
  encoders?: string[]
  ffmpeg?: string
  shaka?: string
  cpuCores?: number
  memoryBytes?: number
  scratchFreeBytes?: number
  /** Enrichment the agent can actually run (transcription needs its own deps). */
  transcription?: boolean
  chapters?: boolean
  hwaccels?: string[]
  probedAt?: number
}

/** The agent fields both projections read. */
export type AgentRow = {
  id: string
  name: string
  enabled: boolean
  lastSeenAt: Date | null
  capabilities: Record<string, unknown> | null
  hostname?: string | null
  agentVersion?: string | null
  capacityJobs?: number
  capacityRenditions?: number
}

export type CapabilityInput = {
  modalWebhookUrl: string | null
  ingestSecret: string | null
  rawBucket: string | null
  transcodedBucket: string | null
  hasStorageCredentials: boolean
  /** Enabled agents, already filtered to those seen inside the liveness window. */
  agents: AgentRow[]
  /** Installation default for new jobs. */
  defaultProvider: string
  /** True when the API will accept new self-hosted submissions at all. */
  selfHostedEnabled: boolean
  aiEnabled: boolean
  /** Injected clock, epoch ms. Defaults to now. */
  now?: number
}

/**
 * How long an agent may be silent before it stops counting as available.
 *
 * Three heartbeat intervals plus slack. Longer and a dead agent keeps answering
 * "yes, import is available" while queuing work nobody will ever run.
 */
export const AGENT_LIVENESS_WINDOW_MS = 90_000

export function isAgentLive(lastSeenAt: Date | null, now = Date.now()): boolean {
  if (!lastSeenAt) return false
  return now - lastSeenAt.getTime() <= AGENT_LIVENESS_WINDOW_MS
}

export type PublicCapabilities = {
  uploads: boolean
  localImport: boolean
  providers: string[]
  defaultProvider: string
  subtitles: boolean
  chapters: boolean
  /** Counts only — never names, hostnames or paths. */
  agents: { paired: number; online: number }
}

export function buildPublicCapabilities(input: CapabilityInput): PublicCapabilities {
  const now = input.now ?? Date.now()
  const online = input.agents.filter(
    (agent) => agent.enabled && isAgentLive(agent.lastSeenAt, now),
  )

  const providers: string[] = []
  const modalReady = Boolean(input.modalWebhookUrl && input.ingestSecret)
  if (modalReady) providers.push('modal')
  if (input.selfHostedEnabled && online.length > 0) providers.push('self-hosted')

  // Upload requires the raw bucket *and* something that can read it. With an
  // explicit self-hosted provider, an agent suffices — which is exactly the
  // case that makes a raw bucket optional for local imports but mandatory for
  // browser uploads.
  const uploads = Boolean(input.rawBucket && input.hasStorageCredentials && modalReady)
    || Boolean(input.rawBucket && input.hasStorageCredentials && online.length > 0)

  return {
    providers,
    defaultProvider: providers.includes(input.defaultProvider)
      ? input.defaultProvider
      : (providers[0] ?? input.defaultProvider),
    uploads,
    localImport:
      input.selfHostedEnabled &&
      input.hasStorageCredentials &&
      Boolean(input.transcodedBucket) &&
      online.length > 0,
    subtitles: input.aiEnabled || online.some((agent) => agent.capabilities?.transcription === true),
    chapters: input.aiEnabled || online.some((agent) => agent.capabilities?.chapters === true),
    agents: {
      paired: input.agents.filter((agent) => agent.enabled).length,
      online: online.length,
    },
  }
}

export type AgentHealth = {
  id: string
  name: string
  online: boolean
  lastSeenAt: string | null
  hostname: string | null
  agentVersion: string | null
  enabled: boolean
  capacityJobs: number
  capacityRenditions: number
  encoders: string[]
  scratchFreeBytes: number | null
  probedAt: string | null
}

/**
 * Authenticated projection: connectivity and capacity, per agent.
 *
 * Still no paths. The dashboard has a separate, explicitly-scoped browse
 * operation for the filesystem, so this one never needs to carry a directory.
 */
export function buildAgentHealth(agents: AgentRow[], now = Date.now()): AgentHealth[] {
  return agents.map((agent) => {
    const capabilities = (agent.capabilities ?? {}) as AgentCapabilities
    return {
      id: agent.id,
      name: agent.name,
      online: agent.enabled && isAgentLive(agent.lastSeenAt, now),
      lastSeenAt: agent.lastSeenAt ? agent.lastSeenAt.toISOString() : null,
      hostname: agent.hostname ?? null,
      agentVersion: agent.agentVersion ?? null,
      enabled: agent.enabled,
      capacityJobs: agent.capacityJobs ?? 1,
      capacityRenditions: agent.capacityRenditions ?? 1,
      encoders: Array.isArray(capabilities.encoders) ? capabilities.encoders : [],
      scratchFreeBytes:
        typeof capabilities.scratchFreeBytes === 'number' ? capabilities.scratchFreeBytes : null,
      probedAt:
        typeof capabilities.probedAt === 'number'
          ? new Date(capabilities.probedAt * 1000).toISOString()
          : null,
    }
  })
}

/**
 * Reject a device that reports no usable encoder.
 *
 * An agent that pairs but cannot encode is worse than no agent: jobs queue
 * forever behind it. Rejecting at registration turns that into an immediate,
 * actionable message.
 */
export function validateCapabilities(value: unknown): { ok: true; value: AgentCapabilities } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: {} }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'capabilities must be an object' }
  }
  const raw = value as Record<string, unknown>
  const capabilities: AgentCapabilities = {}

  if (raw.encoders !== undefined) {
    if (!Array.isArray(raw.encoders) || raw.encoders.some((e) => typeof e !== 'string')) {
      return { ok: false, reason: 'capabilities.encoders must be an array of strings' }
    }
    capabilities.encoders = raw.encoders as string[]
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

/** Encoder backends an agent can offer, in the priority the engine uses. */
export const ENCODER_PRIORITY = ['nvenc', 'vaapi', 'cpu'] as const

export function preferredEncoder(capabilities: AgentCapabilities | null): string {
  const available = new Set(capabilities?.encoders ?? [])
  return ENCODER_PRIORITY.find((name) => available.has(name)) ?? 'cpu'
}
