/**
 * Interactive decision flow (clack TUI), in two passes:
 *
 *   1. `askChoices`   — how this installation is shaped. Decisions only, and
 *                       always asked before anything is installed or collected.
 *   2. `askCredentials` — the values those decisions require. Each credential
 *                       prompt is preceded by the page that creates it, for the
 *                       provider the user actually chose (links live in
 *                       links.ts so they can be tested in one place).
 *
 * Conditional follow-ups (uploads, queue, AI) are sub-prompts of the step they
 * belong to, so the step counter never claims a question that was skipped.
 */

import type {
  ConfigTarget,
  DbAnswers,
  DbKind,
  Prefill,
  QueueAnswers,
  QueueKind,
  RateLimitAnswers,
  RateLimitKind,
  WizardAnswers,
} from './types'
import { DEFAULT_ANSWERS } from './types'
import { linksNote } from './links'
import { probeTcp } from './probe'
import { logWarn, note, askConfirm, askPassword, askSelect, askText, step } from './ui'
import { parsePublicOrigin, proxySettingsFor, type PublicAccess } from './origin'

const POSTGRES_URL_RE = /^postgres(ql)?:\/\/\S+/
const HTTP_URL_RE = /^https?:\/\/\S+/
const REDIS_URL_RE = /^rediss?:\/\/\S+/

const URL_HINTS = {
  postgres: 'must be a postgres:// or postgresql:// URL',
  http: 'must be an absolute http(s) URL',
  redis: 'must be a redis:// or rediss:// URL',
} as const

function requireUrl(message: string, kind: keyof typeof URL_HINTS): Promise<string> {
  return askText(message, {
    validate: (value) => {
      const ok =
        kind === 'postgres'
          ? POSTGRES_URL_RE.test(value)
          : kind === 'redis'
            ? REDIS_URL_RE.test(value)
            : HTTP_URL_RE.test(value)
      if (!ok) {
        return URL_HINTS[kind]
      }
      if (value.includes('your-') || value.includes('change-me')) {
        return 'that looks like a placeholder — paste a real value'
      }
      return undefined
    },
  })
}

export interface AskContext {
  prefill: Prefill
  /** Which configuration this run owns — decides which questions apply. */
  target: ConfigTarget
  /** Account id discovered from an existing wrangler login, if any. */
  accountIdDefault?: string
  /** `scripts/install.sh` — access, proxy, and always-on deploy. */
  hostInstall?: boolean
}

/** The decisions, before any value has been collected. */
export interface Choices {
  target: ConfigTarget
  dbKind: DbKind
  transcodeProvider: 'modal' | 'self-hosted'
  /** Only meaningful (and only asked) for the self-hosted provider. */
  uploadsEnabled: boolean
  queueKind: QueueKind
  rateLimitKind: RateLimitKind
  analyticsEnabled: boolean
  /** Whether to collect a Groq key (Modal provider only). */
  wantGroq: boolean
  hostInstall?: boolean
  access?: PublicAccess
  origin?: string
  acmeEmail?: string
}

export async function askChoices(ctx: AskContext): Promise<Choices> {
  const { prefill, target, hostInstall } = ctx
  const total = hostInstall ? 5 : 4
  let index = 0

  let access: PublicAccess | undefined
  let origin: string | undefined
  let acmeEmail: string | undefined

  if (hostInstall) {
    index += 1
    step(index, total, 'How this machine is reached')
    access =
      (prefill.access === 'localhost' || prefill.access === 'domain' ? prefill.access : undefined) ??
      (await askSelect<PublicAccess>(
        'How should this installation be reached?',
        [
          {
            value: 'localhost',
            label: 'http://localhost on this machine',
            hint: 'loopback only — encoding stays on this host',
          },
          {
            value: 'domain',
            label: 'A public HTTPS hostname',
            hint: 'Caddy terminates TLS; DNS and inbound 80/443 must already point here',
          },
        ],
        'localhost',
      ))
    if (access === 'localhost') {
      origin = 'http://localhost'
      note(
        'The stack will listen on loopback. Modal cannot reach localhost, so encoding\n' +
          'runs on this machine. The installer does not open a firewall or create a tunnel.',
        'Localhost installation',
      )
    } else {
      const typed = await askText('Public hostname (HTTPS, no path or port):', {
        placeholder: 'vod.example.com',
        validate: (value) => {
          const parsed = parsePublicOrigin(value)
          if (!parsed.ok) return parsed.error
          if (parsed.access !== 'domain') return 'enter a public hostname, not localhost'
          return undefined
        },
      })
      const parsed = parsePublicOrigin(typed)
      if (!parsed.ok) throw new Error(parsed.error)
      origin = parsed.origin
      note(
        'Point this hostname at this machine and allow inbound TCP 80 and 443.\n' +
          'Caddy needs those ports reachable from the internet to issue a certificate.\n' +
          'The installer does not modify firewalls or create a tunnel.',
        'DNS and inbound ports',
      )
      const email = await askText('ACME email for certificate notices (optional):', {
        placeholder: 'ops@example.com',
      })
      acmeEmail = email.trim() || undefined
    }
  }

  // ── Postgres ───────────────────────────────────────────────────────────
  index += 1
  step(index, total, 'Postgres')
  const dbKind: DbKind =
    (prefill.dbKind === 'local' || prefill.dbKind === 'existing' ? prefill.dbKind : undefined) ??
    (await askSelect<DbKind>(
      target === 'deploy'
        ? 'Which Postgres should the Compose stack use?'
        : 'Which Postgres should the Node API use?',
      target === 'deploy'
        ? [
            {
              value: 'local',
              label: 'The bundled Postgres service (recommended)',
              hint: 'created and configured by docker-compose.yml',
            },
            { value: 'existing', label: 'I already have a Postgres server' },
          ]
        : [
            {
              value: 'local',
              label: 'The dev Postgres from `pnpm dev:infra` (recommended)',
              hint: 'localhost:5433, started by docker-compose.dev.yml',
            },
            { value: 'existing', label: 'I already have a Postgres server' },
          ],
      'local',
    ))

  // ── Transcoder ─────────────────────────────────────────────────────────
  index += 1
  step(index, total, 'Where videos are encoded')
  const transcodeProvider =
    access === 'localhost'
      ? 'self-hosted'
      : (prefill.transcodeProvider ??
        (await askSelect<'modal' | 'self-hosted'>(
          'How should ClipMux transcode?',
          [
            {
              value: 'modal',
              label: 'Modal (GPU in the cloud — nothing to install here)',
              hint: 'FFmpeg/Shaka/Whisper on Modal; uploads come from the raw R2 bucket',
            },
            {
              value: 'self-hosted',
              label: 'This machine (Docker, your own CPU/GPU)',
              hint: 'the agent reads files from folders you mount — no GPU rental',
            },
          ],
          'modal',
        )))

  // Conditional sub-prompt: a local-only installation may have no uploads at
  // all, which is what makes it valid without a raw bucket.
  let uploadsEnabled = true
  if (transcodeProvider === 'self-hosted') {
    uploadsEnabled =
      prefill.uploadsEnabled ??
      (await askConfirm(
        'Will people also upload files from the browser? (no = only files already on this machine)',
        true,
      ))
    if (!uploadsEnabled) {
      note(
        'No raw upload bucket is needed then. The transcoder agent reads the\n' +
          'folders you mount, and playback still uses Cloudflare R2 + the delivery worker.',
        'Local-only installation',
      )
    }
  }

  // ── 4. How transcode jobs are dispatched ───────────────────────────────
  // Only the Modal path uses a dispatch transport; self-hosted work is queued in
  // the database and claimed by an agent, so the question would be noise.
  let queueKind: QueueKind = 'direct'
  if (transcodeProvider === 'modal') {
    queueKind =
      prefill.queueKind ??
      (await askSelect<QueueKind>(
        'How should transcode jobs reach the Modal pipeline?',
        [
          {
            value: 'direct',
            label: 'Direct HTTP dispatch (recommended)',
            hint: 'no extra service — the API calls the Modal endpoint directly',
          },
          {
            value: 'qstash',
            label: 'QStash (durable retries + queueing)',
            hint: 'requires a QStash token',
          },
        ],
        'direct',
      ))
  }

  // ── 5. Rate limiting ───────────────────────────────────────────────────
  index += 1
  step(index, total, 'Where rate limits are stored')
  const rateLimitKind: RateLimitKind =
    prefill.rateLimitKind ??
    (await askSelect<RateLimitKind>(
      'Where should API rate limits be stored?',
      [
        {
          value: 'memory',
          label: 'In-memory (recommended for one instance)',
          hint: 'no extra service; fine until you run many API replicas',
        },
        {
          value: 'redis' as const,
          label: 'Redis (your own server, shared across replicas)',
          hint: 'REDIS_URL — e.g. redis://localhost:6379; no hosted account',
        },
        {
          value: 'upstash',
          label: 'Upstash Redis (hosted REST)',
          hint: 'requires a REST URL + token',
        },
      ],
      'memory',
    ))

  // ── 6. AI subtitles and chapters ───────────────────────────────────────
  // Modal-only: the prebuilt agent image ships neither Whisper nor the Groq
  // client, so offering it for the local provider would be a promise the
  // installation cannot keep (see docs/known-gaps.md).
  let wantGroq = false
  if (transcodeProvider === 'modal') {
    wantGroq = await askConfirm(
      'Enable AI subtitles/chapters with a Groq API key? (optional)',
      false,
    )
    if (wantGroq) {
      note(
        linksNote(['groq']) +
          '\n\nSkipping it now is fine — the AI steps are simply left out of the pipeline.',
        'Where to get it',
      )
    }
  } else {
    note(
      'AI subtitles and chapters are not included in the prebuilt transcoder\n' +
        'image (it ships neither Whisper nor the Groq client), so they are not\n' +
        'offered for the local provider yet — see docs/known-gaps.md.',
      'Local AI is not available yet',
    )
  }

  const analyticsEnabled =
    prefill.analyticsEnabled ??
    (await askConfirm('Enable Cloudflare Analytics Engine (playback + bandwidth)?', true))

  return {
    target,
    dbKind,
    transcodeProvider,
    uploadsEnabled,
    queueKind,
    rateLimitKind,
    analyticsEnabled,
    wantGroq,
    ...(hostInstall ? { hostInstall: true } : {}),
    ...(access !== undefined ? { access } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(acmeEmail !== undefined ? { acmeEmail } : {}),
  }
}

/**
 * Collect the values the choices require, and return a complete answers object.
 *
 * Everything is conditional on the choices: a self-hosted installation with no
 * uploads is never asked for a raw bucket, a self-hosted one is never asked for
 * a QStash token, and a Modal one always is (when QStash was chosen).
 */
export async function askCredentials(
  choices: Choices,
  options: { accountIdDefault?: string } = {},
): Promise<WizardAnswers> {
  const { target, dbKind, transcodeProvider, uploadsEnabled, queueKind, rateLimitKind, analyticsEnabled } =
    choices
  const needsRawBucket = uploadsEnabled || transcodeProvider === 'modal'

  // ── Postgres ───────────────────────────────────────────────────────────
  let dbUrl: string | undefined
  if (dbKind === 'existing') {
    dbUrl = await requireUrl(
      target === 'deploy'
        ? 'Paste your Postgres DATABASE_URL (reachable from the containers):'
        : 'Paste your Postgres DATABASE_URL (reachable from this machine):',
      'postgres',
    )
  }

  if (dbUrl !== undefined) {
    // Advisory only: a private network or a paused Neon branch is not a reason to
    // refuse a value the user just pasted. The API reports the real problem.
    const reachable = await probeTcp(dbUrl, 5432)
    if (!reachable.found) {
      logWarn(`Postgres at ${reachable.detail ?? 'that address'} did not answer — the value is kept as pasted`)
    }
  }

  // ── Queue ──────────────────────────────────────────────────────────────
  let queueToken: string | undefined
  if (queueKind === 'qstash') {
    note(linksNote(['qstash']), 'Where to get it')
    queueToken = await askPassword('Paste your QStash token:')
  }

  // ── Rate limiting ──────────────────────────────────────────────────────
  let redisUrl: string | undefined
  if (rateLimitKind === 'redis') {
    const suggestion =
      target === 'deploy' ? 'redis://redis:6379 (the bundled service)' : 'redis://localhost:6382'
    redisUrl = await requireUrl(`Paste your Redis URL (e.g. ${suggestion}):`, 'redis')
  }

  if (redisUrl !== undefined) {
    const reachable = await probeTcp(redisUrl, 6379)
    if (!reachable.found) {
      logWarn(`Redis at ${reachable.detail ?? 'that address'} did not answer — the value is kept as pasted`)
    }
  }

  let upstashUrl: string | undefined
  let upstashToken: string | undefined
  if (rateLimitKind === 'upstash') {
    note(linksNote(['upstash']), 'Where to get it')
    upstashUrl = await requireUrl('Paste the Upstash Redis REST URL:', 'http')
    upstashToken = await askPassword('Paste the Upstash Redis token:')
  }

  // ── AI ─────────────────────────────────────────────────────────────────
  let groqApiKey: string | undefined
  if (choices.wantGroq) {
    groqApiKey = await askPassword('Paste your GROQ_API_KEY:')
  }

  // ── Storage, origins and Cloudflare credentials ────────────────────────
  const frontendUrl = choices.origin
    ? choices.origin
    : await askText('Dashboard origin (CORS + FRONTEND_URL):', {
        initialValue: DEFAULT_ANSWERS.frontendUrl,
        validate: (value) =>
          HTTP_URL_RE.test(value) ? undefined : 'must be an absolute http(s) URL',
      })

  let rawBucket = DEFAULT_ANSWERS.rawBucket
  if (needsRawBucket) {
    rawBucket = await askText('Raw upload bucket name (Cloudflare R2):', {
      initialValue: DEFAULT_ANSWERS.rawBucket,
      validate: (value) => (value.trim() ? undefined : 'bucket name is required'),
    })
  }
  const transcodedBucket = await askText('Transcoded bucket name (Cloudflare R2):', {
    initialValue: DEFAULT_ANSWERS.transcodedBucket,
    validate: (value) => (value.trim() ? undefined : 'bucket name is required'),
  })

  const storageNote = needsRawBucket
    ? 'Storage (R2 buckets) and the delivery worker are Cloudflare-only in this\n' +
      'release. Wrangler can create the buckets for you during the deploy phase,\n' +
      'but it cannot mint S3 API tokens.\n\n' +
      linksNote(['r2ApiTokens', 'cfAccountId'])
    : 'Delivery is still Cloudflare: the transcoded bucket and the delivery worker\n' +
      'are how anyone plays the video. No raw bucket is needed — nothing uploads.\n\n' +
      linksNote(['r2ApiTokens', 'cfAccountId'])
  note(storageNote, 'What this step needs')

  const accountId = await askText('Cloudflare account id (32-hex):', {
    initialValue: options.accountIdDefault,
    placeholder: 'e.g. a1b2c3d4e5f60718293a4b5c6d7e8f90',
    validate: (value) =>
      value.trim()
        ? /^[0-9a-f]{32}$/i.test(value.trim())
          ? undefined
          : 'should be the 32-hex id from dash.cloudflare.com'
        : 'Cloudflare account id is required',
  })
  const r2AccessKeyId = await askText('R2 Access Key ID:', {
    validate: (value) => (value.trim() ? undefined : 'R2 Access Key ID is required'),
  })
  const r2SecretAccessKey = await askPassword('R2 Secret Access Key:')

  const db: DbAnswers = { kind: dbKind, ...(dbUrl !== undefined ? { url: dbUrl } : {}) }
  const queue: QueueAnswers = {
    kind: queueKind,
    ...(queueToken !== undefined ? { token: queueToken } : {}),
  }
  const rateLimit: RateLimitAnswers = {
    kind: rateLimitKind,
    ...(redisUrl !== undefined ? { url: redisUrl } : {}),
    ...(upstashUrl !== undefined ? { restUrl: upstashUrl } : {}),
    ...(upstashToken !== undefined ? { token: upstashToken } : {}),
  }

  return {
    target,
    db,
    queue,
    rateLimit,
    transcodeProvider,
    uploadsEnabled,
    analyticsEnabled,
    accountId: accountId.trim(),
    r2AccessKeyId: r2AccessKeyId.trim(),
    r2SecretAccessKey: r2SecretAccessKey.trim(),
    rawBucket: rawBucket.trim(),
    transcodedBucket: transcodedBucket.trim(),
    frontendUrl: frontendUrl.trim(),
    ...(groqApiKey ? { groqApiKey: groqApiKey.trim() } : {}),
    ...(choices.hostInstall ? { hostInstall: true } : {}),
    ...(choices.access !== undefined ? { access: choices.access } : {}),
    ...(choices.origin !== undefined && choices.access !== undefined
      ? {
          proxy: proxySettingsFor(
            { origin: choices.origin, access: choices.access },
            choices.acmeEmail,
          ),
        }
      : {}),
  }
}
