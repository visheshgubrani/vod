import { isNull, relations, sql } from 'drizzle-orm'
import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  pgEnum,
  integer,
  bigint,
  uuid,
  jsonb,
} from 'drizzle-orm/pg-core'

// =========================================
// 1. BETTER AUTH TABLES (Auto-Generated)
// =========================================

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
    activeOrganizationId: text('active_organization_id'),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)

export const organization = pgTable(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    createdAt: timestamp('created_at').notNull(),
    metadata: text('metadata'),
  },
  (table) => [uniqueIndex('organization_slug_uidx').on(table.slug)],
)

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').default('member').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (table) => [
    index('member_organizationId_idx').on(table.organizationId),
    index('member_userId_idx').on(table.userId),
  ],
)

export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').default('pending').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('invitation_organizationId_idx').on(table.organizationId),
    index('invitation_email_idx').on(table.email),
  ],
)

// =========================================
// 2. VIDEO PLATFORM LOGIC (Your Additions)
// =========================================

export const statusEnum = pgEnum('video_status', [
  'pending',
  'uploading',
  'processing',
  'ready',
  'failed',
])

// Playback policy for access control (like Mux)
// - public: anyone can access the video
// - signed: requires a signed token/URL to access
export const playbackPolicyEnum = pgEnum('playback_policy', [
  'public',
  'signed',
])

export const video = pgTable('video', {
  id: uuid('id').defaultRandom().primaryKey(),

  // Links to the Organization (Tenant)
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),

  title: text('title').notNull(),
  status: statusEnum('status').default('pending'),
  playbackPolicy: playbackPolicyEnum('playback_policy').default('public'),

  // R2 Storage Paths
  rawKey: text('raw_key'),
  hlsUrl: text('hls_url'),
  thumbnailUrl: text('thumbnail_url'),

  duration: integer('duration'), // in seconds
  size: bigint('size', { mode: 'number' }), // in bytes (bigint for files > 2GB)
  uploadedBy: text('uploaded_by')
    .references(() => user.id, { onDelete: 'cascade' }), // Nullable for B2B uploads
  resolutions: text('resolutions'),
  metadata: text('metadata'),

  // Subtitle/Caption generation
  generateSubtitle: boolean('generate_subtitle').default(false),
  subtitleStatus: text('subtitle_status'), // 'pending' | 'processing' | 'completed' | 'failed'
  subtitleUrl: text('subtitle_url'), // URL to the generated subtitle file (VTT/SRT)

  // AI Chapters generation
  generateChapters: boolean('generate_chapters').default(false),
  chaptersStatus: text('chapters_status'), // 'pending' | 'processing' | 'completed' | 'failed'
  chapters: jsonb('chapters').$type<Array<{ startTime: number; endTime: number; title: string }>>(),

  // Storage tracking for usage metering
  transcodedSize: bigint('transcoded_size', { mode: 'number' }), // Total bytes of transcoded files (HLS + poster + subtitles)

  // Processing metrics
  transcodedTime: integer('transcoded_time'), // Transcoding duration in seconds

  // Job lifecycle tracking (heartbeats, sweeps, retries)
  processingStartedAt: timestamp('processing_started_at'), // when the current job attempt started
  jobAttempts: integer('job_attempts').default(0), // successful dispatch attempts
  lastHeartbeatAt: timestamp('last_heartbeat_at'), // last heartbeat from the transcoder
  failureCode: text('failure_code'), // typed machine-readable failure reason

  // Attempt ownership. Every dispatch mints a fresh attempt id which must be
  // echoed by the transcoder's callbacks and heartbeats; a callback naming any
  // other attempt is rejected. The lease is how a crashed attempt stops
  // counting against the org concurrency cap and becomes reclaimable.
  //
  // Both are timestamptz on purpose: the claim compares them against now() in
  // the admission subquery, and a naive column would make that comparison
  // depend on the session timezone.
  transcodeAttemptId: text('transcode_attempt_id'),
  transcodeLeaseExpiresAt: timestamp('transcode_lease_expires_at', { withTimezone: true }),

  // Soft deletion. Set by the deletion paths; the cleanup job (and its
  // reconciliation) is what actually reclaims bytes. A row with deleted_at set
  // must never be claimed, mutated by a callback, or returned by a library read.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  // Composite covers org-only filters too (leading column), and serves the
  // per-org in-flight count the transcode claim runs on every dispatch.
  index('video_org_status_idx').on(table.organizationId, table.status),
  index('video_status_updatedAt_idx').on(table.status, table.updatedAt),
  // Reconciliation scans for deleted rows whose cleanup is still outstanding.
  index('video_deletedAt_idx').on(table.deletedAt),
])

export const apiKey = pgTable(
  'api_key',
  {
    id: text('id').primaryKey(), // "sk_live_..."
    keyHash: text('key_hash').notNull(), // SHA-256 digest of the secret key
    keyLast4: text('key_last4').notNull(), // Last 4 chars for masked previews
    name: text('name').notNull(), // "Production Key"

    // Linked to Organization
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    label: text('label'),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [uniqueIndex('api_key_key_hash_idx').on(table.keyHash)],
)

/**
 * Transactional outbox for lifecycle events.
 *
 * The event is written by the SAME database operation as the state change it
 * describes. Without that, a process that dies between "video is ready" and
 * "emit video.ready" loses the event permanently: the callback retry finds the
 * row already `ready`, the state guard ignores it, and the tenant never learns
 * their video is playable.
 *
 * `id` is the event id sent to receivers and is stable across every retry of
 * that event — that stability is what lets a receiver deduplicate, since
 * delivery is at-least-once.
 */
export const eventOutbox = pgTable(
  'event_outbox',
  {
    id: text('id').primaryKey(), // "evt_..."
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /**
     * pending -> dispatching -> dispatched, or failed.
     * `dispatching` means a runner holds the lease and is fanning the event out
     * to subscribed endpoints; a stale `dispatching` row is reclaimed by lease
     * expiry, so no separate reaper is needed.
     */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** Set while a runner holds the row; only the lease holder may finalize it. */
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (table) => [
    index('event_outbox_status_next_idx').on(table.status, table.nextAttemptAt),
    index('event_outbox_org_created_idx').on(table.organizationId, table.createdAt),
  ],
)

/**
 * Durable record that a video's bytes still need reclaiming.
 *
 * Why this exists rather than a `waitUntil` cleanup call: deleting the row and
 * deleting the bytes are two different systems, and the row delete is the one
 * that must not be lost. `waitUntil` only extends execution for ~30s after the
 * response, so a slow or failing object delete silently leaked bytes with no
 * record that any were owed. Here the debt is written in the same operation as
 * the deletion, and reconciled later.
 *
 * `video_id` is deliberately **not** a foreign key. Rows reach this table by two
 * routes: soft deletion (the video row survives, so an FK would work) and the
 * `AFTER DELETE` trigger on `video` — which fires for cascades from deleting an
 * organization or a user, i.e. exactly when the video row no longer exists.
 *
 * Buckets are not stored: they are resolved from configuration when the job
 * runs, which keeps the trigger trivial and lets bucket names be renamed.
 */
export const storageCleanupJob = pgTable(
  'storage_cleanup_job',
  {
    id: text('id').primaryKey(),
    videoId: uuid('video_id').notNull(),
    organizationId: text('organization_id'),
    /** Raw upload object, when the video had one. */
    rawKey: text('raw_key'),
    /** Prefix holding every transcoded artefact: `videos/<id>/`. */
    prefix: text('prefix').notNull(),
    /** pending | reclaimed | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Bytes reclaimed so far, for observability. */
    objectsDeleted: integer('objects_deleted').notNull().default(0),
    /**
     * Earliest time this job may act. Set past the longest-lived outstanding
     * writer (presigned upload URLs) so we never delete underneath a writer
     * that is still legitimately allowed to write.
     */
    notBefore: timestamp('not_before', { withTimezone: true }).notNull().defaultNow(),
    /** Run only by the lease holder, so two sweepers cannot both finalize. */
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    reclaimedAt: timestamp('reclaimed_at', { withTimezone: true }),
    /** Set once a reclaimed job has been re-verified empty. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('storage_cleanup_status_notbefore_idx').on(table.status, table.notBefore),
    // At most one outstanding job per **(video, prefix)**: an application
    // deletion path and the AFTER DELETE trigger can both enqueue cleanup, and
    // duplicates double the work while making failure counts meaningless.
    // Reclaimed jobs are excluded so a video can be cleaned up again if objects
    // ever reappear.
    //
    // Keyed on the prefix rather than the video alone, because a *failed or
    // superseded attempt* needs its own prefix reclaimed while the video stays
    // live. Keyed on the video, that second job could never be enqueued — the
    // index would reject it and the abandoned attempt's bytes would leak until
    // the video itself was deleted, which may be never.
    uniqueIndex('storage_cleanup_one_outstanding_idx')
      .on(table.videoId, table.prefix)
      .where(sql`${table.status} <> 'reclaimed'`),
  ],
)

export const webhookEndpoint = pgTable('webhook_endpoint', {
  id: text('id').primaryKey(), // "whep_..."
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  url: text('url').notNull(), // HTTPS endpoint URL
  secret: text('secret').notNull(), // HMAC signing secret
  events: text('events').array(), // ['video.ready', 'subtitle.generated', ...]
  enabled: boolean('enabled').default(true),
  description: text('description'),
  lastTriggeredAt: timestamp('last_triggered_at'),
  createdAt: timestamp('created_at').defaultNow(),
})

/**
 * Per-endpoint delivery attempts for one outbox event.
 *
 * Split from `event_outbox` because fan-out is one-to-many: an event must be
 * retried independently per endpoint, and one dead receiver must not hold up
 * delivery to the others. The outbox row records that the domain event
 * happened; these rows record whether each subscriber has been told.
 *
 * Delivery is **at-least-once**. `event_id` is the stable id receivers
 * deduplicate on; the same event retried to the same endpoint keeps it, and
 * `X-Webhook-Id` carries it. Exactly-once is not promised and cannot be: a
 * response lost after the receiver committed its side effect is
 * indistinguishable from one lost before.
 */
export const webhookDelivery = pgTable(
  'webhook_delivery',
  {
    id: text('id').primaryKey(), // "whd_..."
    eventId: text('event_id')
      .notNull()
      .references(() => eventOutbox.id, { onDelete: 'cascade' }),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoint.id, { onDelete: 'cascade' }),
    /** URL and secret are snapshotted: a later endpoint edit must not silently
     *  redirect an event that was already recorded, nor leak a rotated secret. */
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    /** pending | delivered | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** Only the holder of a live lease may finalize this row. */
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [
    index('webhook_delivery_status_next_idx').on(table.status, table.nextAttemptAt),
    index('webhook_delivery_endpoint_created_idx').on(table.endpointId, table.createdAt),
    uniqueIndex('webhook_delivery_event_endpoint_uidx').on(
      table.eventId,
      table.endpointId,
    ),
  ],
)

/**
 * Short-lived upload tokens for B2B customers to enable direct frontend uploads
 * without exposing API keys. Customers generate these tokens from their backend
 * and pass them to their frontend for secure, direct-to-R2 uploads.
 */
export const uploadToken = pgTable('upload_token', {
  id: text('id').primaryKey(), // "ut_xxxxx"
  token: text('token').notNull().unique(), // The secret token value
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  apiKeyId: text('api_key_id') // Which API key created this token
    .references(() => apiKey.id, { onDelete: 'cascade' }),

  // Usage constraints
  maxFiles: integer('max_files').default(1), // How many uploads allowed with this token
  usedFiles: integer('used_files').default(0), // How many uploads have been used
  maxSizeBytes: bigint('max_size_bytes', { mode: 'number' }), // Optional size limit per file

  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
})

// =========================================
// 3. RELATIONS
// =========================================

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}))

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}))

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
  videos: many(video), // <--- Added
  apiKeys: many(apiKey), // <--- Added
}))

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}))

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}))

export const videoRelations = relations(video, ({ one }) => ({
  organization: one(organization, {
    fields: [video.organizationId],
    references: [organization.id],
  }),
}))

export const apiKeyRelations = relations(apiKey, ({ one }) => ({
  organization: one(organization, {
    fields: [apiKey.organizationId],
    references: [organization.id],
  }),
}))

/**
 * Single-row heartbeat for the maintenance runner.
 *
 * `SWEEP_ENABLED=true` records intent; this records evidence. Without it a
 * deployment whose cron never fires — a bad pattern, a Worker that fails to
 * deploy, a compose service with the secret missing — looks perfectly healthy
 * while webhook retries and byte reclamation silently never happen.
 *
 * One row, keyed by a constant, updated at the start and end of every pass.
 */
export const maintenanceRun = pgTable('maintenance_run', {
  id: text('id').primaryKey(),
  lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
  lastSucceededAt: timestamp('last_succeeded_at', { withTimezone: true }),
  lastDurationMs: integer('last_duration_ms'),
  lastError: text('last_error'),
})

// =========================================
// 4. SELF-HOSTED TRANSCODING (AGENT PLANE)
// =========================================

/**
 * Where a job's bytes come from.
 *
 * A typed source rather than a nullable `raw_key`, because the retry and sweeper
 * paths have to resolve "what do I re-encode?" without knowing which provider was
 * chosen. `raw_key` alone cannot express "a file on Dana's workstation", and the
 * code that assumed it could is what makes a local-only install impossible.
 *
 *   local -> the file lives on the machine of `agent_id`
 *   r2    -> the file lives in the raw bucket at `r2_bucket`/`r2_key`
 *   url   -> a one-off public URL (Modal's `input_url` path)
 *
 * `kind = 'local'` sources are **bound to one agent**: only the machine holding
 * the file can read it. That binding is the reason a local job cannot simply be
 * moved to another agent when one goes offline, and the reason the dashboard
 * shows "waiting for agent" instead.
 */
export const transcodeSource = pgTable(
  'transcode_source',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** local | r2 | url */
    kind: text('kind').notNull(),

    // ── local ───────────────────────────────────────────────────────────────
    /** The only agent that can read this source. Null for r2/url sources. */
    agentId: text('agent_id'),
    /** Configured root name, as shown to the owner ("media"). */
    rootName: text('root_name'),
    /** Root-relative path. Absolute host paths are never stored or returned. */
    relativePath: text('relative_path'),
    fileName: text('file_name'),
    /**
     * Cheap identity (device:inode:size:mtime) captured when the file was
     * registered. Comparing it at execution time is how "the original moved or
     * changed" is detected without hashing a multi-gigabyte file.
     */
    identity: text('identity'),
    /** SHA-256 of the snapshot, filled once a job has read the file. */
    contentSha256: text('content_sha256'),

    // ── r2 / url ────────────────────────────────────────────────────────────
    r2Bucket: text('r2_bucket'),
    r2Key: text('r2_key'),
    inputUrl: text('input_url'),

    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** available | missing | changed | unverified */
    availability: text('availability').notNull().default('available'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('transcode_source_org_idx').on(table.organizationId, table.createdAt),
    index('transcode_source_agent_idx').on(table.agentId),
  ],
)

/**
 * A paired self-hosted agent.
 *
 * Credentials are stored **hashed** and are organization-scoped, so a stolen
 * agent token cannot mint playback tokens, administer users, or read another
 * tenant's jobs. `capabilities` is the JSON report the agent sends: it is
 * advisory (the dashboard renders it and the dispatcher may use it to avoid
 * routing a job to a machine with no usable encoder), never authoritative — the
 * agent re-probes before it encodes.
 */
export const transcoderAgent = pgTable(
  'transcoder_agent',
  {
    id: text('id').primaryKey(), // "agt_..."
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Last 4 characters of the token, for a masked dashboard preview. */
    tokenLast4: text('token_last4').notNull(),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>(),
    agentVersion: text('agent_version'),
    hostname: text('hostname'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** Operator-declared job and rendition concurrency for this machine. */
    capacityJobs: integer('capacity_jobs').notNull().default(1),
    capacityRenditions: integer('capacity_renditions').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    /** Set when the credential is revoked; the row is kept for the audit trail. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('transcoder_agent_token_hash_idx').on(table.tokenHash),
    index('transcoder_agent_org_idx').on(table.organizationId, table.createdAt),
  ],
)

/**
 * Short-lived pairing codes.
 *
 * The code is the only secret that ever travels through a human channel (the
 * dashboard shows it, the owner pastes it into the agent). It is single-use,
 * expires quickly, and is replaced by a machine credential on first redemption —
 * so a code read over someone's shoulder is useless after one use.
 */
export const transcoderPairing = pgTable(
  'transcoder_pairing',
  {
    id: text('id').primaryKey(), // "pair_..."
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    codeLast4: text('code_last4').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    /** Pre-filled name so the paired agent is recognisable in the list. */
    suggestedName: text('suggested_name'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByAgentId: text('consumed_by_agent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('transcoder_pairing_code_hash_idx').on(table.codeHash),
    index('transcoder_pairing_org_idx').on(table.organizationId, table.createdAt),
  ],
)

/**
 * The durable queue for self-hosted work.
 *
 * This is a row in Postgres rather than a message in a broker on purpose: the
 * database is already the authority for `video.status` and the lifecycle outbox,
 * and a second system of record would need its own reconciliation against it.
 * Queue state and attempt ownership therefore move in one transaction.
 *
 * `video.status` stays the *application-facing* vocabulary (`processing`); this
 * row carries the finer-grained state (`queued`/`running`/`publishing`) and,
 * separately, `waiting_reason` — because "queued because the agent is offline"
 * and "queued because three jobs are ahead of it" need different UI and
 * different operator responses.
 *
 * `options` is immutable once written. The provider is stored here too, so
 * changing the installation default never reroutes a job that already exists.
 */
export const transcodeJob = pgTable(
  'transcode_job',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** modal | self-hosted — selected when the job is created, never re-derived. */
    provider: text('provider').notNull(),
    sourceId: uuid('source_id').references(() => transcodeSource.id, {
      onDelete: 'set null',
    }),
    /** Preferred/bound agent. Local sources are pinned to exactly one. */
    agentId: text('agent_id'),

    /** Frozen ProcessingOptions blob. See `options.py` for the field set. */
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),

    /** queued | claimed | running | publishing | succeeded | failed | cancelled */
    state: text('state').notNull().default('queued'),
    /**
     * Why a queued job is not running. Deliberately a separate field from
     * `state`: the state vocabulary is about progress, this is about the cause,
     * and collapsing them loses the distinction the dashboard needs.
     * Null | agent-offline | agent-busy | source-missing | source-changed
     *      | capacity | retry-backoff
     */
    waitingReason: text('waiting_reason'),

    /** The owning attempt. Kept in lockstep with `video.transcode_attempt_id`. */
    attemptId: text('attempt_id'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    /**
     * Waiting on an offline source must not burn the retry budget: a job whose
     * file is on a laptop that is currently shut has not *failed* three times.
     * This counter is how "we tried and it broke" is separated from "we waited".
     */
    sourceWaitCount: integer('source_wait_count').notNull().default(0),

    failureCode: text('failure_code'),
    lastError: text('last_error'),
    /**
     * The completion the agent reported, kept after the job succeeds.
     *
     * Completion is replayed whenever the agent did not see the response. A
     * replay must be answered with the *same* receipt rather than a 404: the
     * work is done, and "already done, here is what happened" is the only
     * answer that lets an agent clear its journal instead of retrying forever.
     */
    completionReceipt: jsonb('completion_receipt').$type<Record<string, unknown>>(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Caller-supplied dedupe key for an import.
     *
     * A CLI import that retries after a lost response must not create a second
     * video and a second encode. The key is stored on the job rather than in a
     * separate table so the uniqueness check and the insert are one operation.
     */
    idempotencyKey: text('idempotency_key'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The claim scans for eligible work by agent and state; the sweeper scans by
    // state and lease. Both are covered by these two.
    index('transcode_job_state_agent_idx').on(table.state, table.agentId),
    index('transcode_job_lease_idx').on(table.state, table.leaseExpiresAt),
    index('transcode_job_video_idx').on(table.videoId),
    index('transcode_job_org_created_idx').on(table.organizationId, table.createdAt),
    // Scoped per organization: one tenant's key must not block another's, and a
    // null key (no dedupe requested) is exempt from the constraint.
    uniqueIndex('transcode_job_idempotency_uidx')
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    // At most one *runnable* job per video.
    //
    // Import idempotency alone is not enough: a caller with no key (or a key
    // that arrived after a crash) could otherwise queue a second encode of the
    // same video, and both jobs would be claimable. The guard is a property of
    // the data rather than of the caller's discipline. Terminal states are
    // excluded so a retry can queue a fresh job.
    uniqueIndex('transcode_job_one_runnable_per_video_uidx')
      .on(table.videoId)
      .where(sql`${table.state} IN ('queued', 'claimed', 'running', 'publishing')`),
  ],
)

/**
 * A short-lived request for the agent to act on the owner's behalf.
 *
 * The browser never connects to the agent — the agent has no public listener by
 * design, because requiring port forwarding or a tunnel would make self-hosting
 * a networking exercise. So a browse request is written here, the agent picks it
 * up on its next poll, and the result is written back. `expires_at` bounds how
 * long a response is still interesting: a folder listing from ten minutes ago
 * may describe a machine that has since gone away.
 */
export const agentControlRequest = pgTable(
  'agent_control_request',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    /** browse | register-source | reselect-source | doctor */
    kind: text('kind').notNull(),
    request: jsonb('request').$type<Record<string, unknown>>().notNull().default({}),
    /** pending | delivered | completed | failed | expired */
    status: text('status').notNull().default('pending'),
    response: jsonb('response').$type<Record<string, unknown>>(),
    error: text('error'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('agent_control_agent_status_idx').on(table.agentId, table.status),
    index('agent_control_org_created_idx').on(table.organizationId, table.createdAt),
  ],
)

/**
 * The artifact inventory for one attempt.
 *
 * This is what makes "the video is ready" mean "the bytes are actually there".
 * The agent uploads against a grant derived from this list, records sizes and
 * checksums, and completion is refused until every listed item is verified
 * present. Without it, a partial upload marks a video playable and the failure
 * surfaces to a viewer mid-lecture.
 *
 * One inventory per attempt: a retry gets a new attempt, a new prefix and a new
 * inventory, so a stale attempt's rows can never be mistaken for the live one's.
 */
export const artifactInventory = pgTable(
  'artifact_inventory',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => transcodeJob.id, { onDelete: 'cascade' }),
    attemptId: text('attempt_id').notNull(),
    /**
     * Attempt-scoped key prefix, e.g. `videos/<id>/attempts/<attempt>`.
     * Stored rather than derived so publication uses the prefix that was
     * actually uploaded to, even if the derivation rule changes later.
     */
    prefix: text('prefix').notNull(),
    /** open | registering | verified | failed | superseded */
    status: text('status').notNull().default('open'),
    itemCount: integer('item_count').notNull().default(0),
    verifiedCount: integer('verified_count').notNull().default(0),
    lastError: text('last_error'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('artifact_inventory_attempt_uidx').on(table.attemptId),
    index('artifact_inventory_video_idx').on(table.videoId),
    index('artifact_inventory_status_idx').on(table.status),
  ],
)

/**
 * One expected artifact.
 *
 * `status` deliberately distinguishes `uploaded` from `verified`: the agent
 * saying it sent a file and the API confirming the object exists at the recorded
 * size are different claims, and only the second may gate publication. Multipart
 * ETags are never used as content hashes — they are not stable across part sizes
 * — so `checksum` is the agent's own SHA-256 and is what a mismatch is reported
 * against.
 */
export const artifactInventoryItem = pgTable(
  'artifact_inventory_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inventoryId: uuid('inventory_id')
      .notNull()
      .references(() => artifactInventory.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum'),
    role: text('role').notNull().default('segment'),
    /** pending | uploaded | verified | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('artifact_item_inventory_path_uidx').on(table.inventoryId, table.path),
    index('artifact_item_status_idx').on(table.inventoryId, table.status),
  ],
)
