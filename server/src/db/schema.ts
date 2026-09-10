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
    // At most one outstanding job per video: an application deletion path and
    // the AFTER DELETE trigger can both enqueue cleanup, and duplicates double
    // the work while making failure counts meaningless. Reclaimed jobs are
    // excluded so a video can be cleaned up again if objects ever reappear.
    uniqueIndex('storage_cleanup_one_outstanding_idx')
      .on(table.videoId)
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
