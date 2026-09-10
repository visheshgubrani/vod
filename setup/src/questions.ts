/**
 * Interactive decision flow (clack TUI). Every question falls back to a
 * default on Enter; every secret is collected with askPassword and only ever
 * stored in .dev.vars files, never echoed.
 */

import type {
  DbKind,
  Prefill,
  QueueKind,
  RateLimitKind,
  RuntimeKind,
  WizardAnswers,
} from './types'
import { DEFAULT_ANSWERS } from './types'
import { askConfirm, askPassword, askSelect, askText, note } from './ui'

const POSTGRES_URL_RE = /^postgres(ql)?:\/\/\S+/
const HTTP_URL_RE = /^https?:\/\/\S+/

function requireUrl(message: string, kind: 'postgres' | 'http'): Promise<string> {
  return askText(message, {
    validate: (value) => {
      const ok = kind === 'postgres' ? POSTGRES_URL_RE.test(value) : HTTP_URL_RE.test(value)
      if (!ok) {
        return kind === 'postgres'
          ? 'must be a postgres:// or postgresql:// URL'
          : 'must be an absolute http(s) URL'
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
  /** Account id discovered from an existing wrangler login, if any. */
  accountIdDefault?: string
}

export async function askQuestions(ctx: AskContext): Promise<WizardAnswers> {
  const prefill = ctx.prefill

  const runtime: RuntimeKind =
    prefill.runtime ??
    (await askSelect<RuntimeKind>(
      'Where should the OpenVOD API run?',
      [
        {
          value: 'workers',
          label: 'Cloudflare Workers (managed)',
          hint: 'DB_DRIVER=neon-http — deploy with wrangler; Postgres must be Neon',
        },
        {
          value: 'compose',
          label: 'Node via Docker Compose (self-hosted)',
          hint: 'DB_DRIVER=pg — docker compose runs Postgres + API + dashboard',
        },
      ],
      'workers',
    ))

  // ── Postgres ───────────────────────────────────────────────────────────
  // A --db prefill only applies when it is valid for the chosen runtime
  // (workers ⇒ neon only; compose ⇒ local/existing); otherwise fall back.
  const prefillDbValid =
    prefill.dbKind !== undefined &&
    (prefill.dbKind === 'neon' ? runtime === 'workers' : runtime === 'compose')
  const dbKind: DbKind =
    (prefillDbValid ? prefill.dbKind : undefined) ??
    (runtime === 'workers'
      ? 'neon'
      : await askSelect<DbKind>(
          'Which Postgres should the Node API use?',
          [
            {
              value: 'local',
              label: 'Compose Postgres (recommended)',
              hint: 'container-internal URL is set by docker-compose.yml',
            },
            { value: 'existing', label: 'I already have a Postgres server' },
          ],
          'local',
        ))

  let dbUrl: string | undefined
  if (dbKind === 'neon') {
    note(
      'Workers use the neon-http driver, so DATABASE_URL must be a Neon project URL.\n' +
        'Create a project at https://console.neon.tech and paste its connection string.',
      'Postgres (Neon)',
    )
    dbUrl = await requireUrl('Paste the Neon project DATABASE_URL:', 'postgres')
  } else if (dbKind === 'existing') {
    dbUrl = await requireUrl(
      'Paste your Postgres DATABASE_URL (reachable from your docker host):',
      'postgres',
    )
  }

  // ── Queue ──────────────────────────────────────────────────────────────
  const queueKind: QueueKind =
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
          hint: 'requires a QStash token from console.upstash.com/qstash',
        },
      ],
      'direct',
    ))
  const queueToken =
    queueKind === 'qstash' ? await askPassword('Paste your QStash token:') : undefined

  // ── Rate limiting ──────────────────────────────────────────────────────
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
          value: 'upstash',
          label: 'Upstash Redis (shared across replicas)',
          hint: 'requires REST URL + token from console.upstash.com',
        },
      ],
      'memory',
    ))
  let upstashUrl: string | undefined
  let upstashToken: string | undefined
  if (rateLimitKind === 'upstash') {
    upstashUrl = await requireUrl('Paste the Upstash Redis REST URL:', 'http')
    upstashToken = await askPassword('Paste the Upstash Redis token:')
  }

  // ── Optional Groq ──────────────────────────────────────────────────────
  const wantGroq = await askConfirm(
    'Enable AI subtitles/chapters with a Groq API key? (optional)',
    false,
  )
  const groqApiKey = wantGroq ? await askPassword('Paste your GROQ_API_KEY:') : undefined

  // ── Origins & buckets ──────────────────────────────────────────────────
  const frontendUrl = await askText('Dashboard origin (CORS + FRONTEND_URL):', {
    initialValue: DEFAULT_ANSWERS.frontendUrl,
    validate: (value) =>
      HTTP_URL_RE.test(value) ? undefined : 'must be an absolute http(s) URL',
  })
  const rawBucket = await askText('Raw upload bucket name (Cloudflare R2):', {
    initialValue: DEFAULT_ANSWERS.rawBucket,
    validate: (value) => (value.trim() ? undefined : 'bucket name is required'),
  })
  const transcodedBucket = await askText('Transcoded bucket name (Cloudflare R2):', {
    initialValue: DEFAULT_ANSWERS.transcodedBucket,
    validate: (value) => (value.trim() ? undefined : 'bucket name is required'),
  })

  // ── Cloudflare credentials ─────────────────────────────────────────────
  note(
    'Storage (R2 buckets) and the delivery worker are Cloudflare-only in this\n' +
      'release. Wrangler can create buckets for you during the deploy phase, but it\n' +
      'cannot mint S3 API tokens — create one at:\n' +
      'https://dash.cloudflare.com/?to=/:account/r2/api-tokens\n' +
      'Permission: Object Read & Write on both buckets (or the whole account).',
    'Cloudflare (locked for now)',
  )
  const accountId = await askText('Cloudflare account id (32-hex):', {
    initialValue: ctx.accountIdDefault,
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

  return {
    runtime,
    db: { kind: dbKind, ...(dbUrl !== undefined ? { url: dbUrl } : {}) },
    queue: { kind: queueKind, ...(queueToken !== undefined ? { token: queueToken } : {}) },
    rateLimit: {
      kind: rateLimitKind,
      ...(upstashUrl !== undefined ? { restUrl: upstashUrl } : {}),
      ...(upstashToken !== undefined ? { token: upstashToken } : {}),
    },
    accountId: accountId.trim(),
    r2AccessKeyId: r2AccessKeyId.trim(),
    r2SecretAccessKey: r2SecretAccessKey.trim(),
    rawBucket: rawBucket.trim(),
    transcodedBucket: transcodedBucket.trim(),
    frontendUrl: frontendUrl.trim(),
    ...(groqApiKey ? { groqApiKey: groqApiKey.trim() } : {}),
  }
}
