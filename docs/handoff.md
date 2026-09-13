# Handoff — reliability, ownership and reclamation

This documents the work landed in `156f76e` and `402f372`, what is verified,
what is deliberately not done, and what to check before deploying.

## Deploy checklist

Seven migrations are new (`0010`–`0016`). **Nothing works until they are applied.**

```bash
pnpm --filter vod-api db:migrate   # applies the committed SQL, in order
# or, Docker: the API container migrates on boot
```

**Use `db:migrate`, not `db:push`.** `push` derives changes from the TypeScript
schema, so it cannot create the hand-written objects in migrations `0013`,
`0014` and `0016` — the `AFTER DELETE` cleanup trigger and the unique index that
deduplicates cleanup jobs. A deployment that has only ever been `push`ed will be
missing the trigger, and deleting a video through a cascade will silently leak
its bytes.

Verify after migrating:

```bash
psql "$DATABASE_URL" -tAc \
  "SELECT tgname FROM pg_trigger WHERE tgname = 'video_enqueue_storage_cleanup';"
# expect one row
```

### Migrating a database built by `db:push`

A database created with `push` has the tables but **no migration history and no
cleanup trigger**. There is no shortcut: `drizzle.__drizzle_migrations` stores a
hash per migration plus a timestamp, and the journal file contains no hashes, so
neither "insert the journal hashes" nor "diff the schema" is a real procedure.
Nor is the SQL uniformly idempotent — the earlier claim that it was is wrong.

Use the fresh-database route below. **It is tested** against a database built to
mimic the `push` state (tables and data present, trigger absent, no history).

```bash
OLD=postgresql://…/mydb          # the push-managed database
NEW=mydb_migrated

# 1. Data only, public schema only. Excluding the drizzle schema is what keeps
#    the old (absent) bookkeeping from being restored over the new one.
pg_dump --data-only --schema=public --no-owner --no-privileges "$OLD" > data.sql

# 2. Fresh database, migrated from the committed SQL.
createdb "$NEW"
DATABASE_URL="postgresql://…/$NEW" pnpm db:migrate

# 3. Restore the data.
psql -v ON_ERROR_STOP=1 -d "$NEW" -f data.sql

# 4. Validate BEFORE switching the deployment over.
psql -d "$NEW" -tAc "
  SELECT 'trigger=' || EXISTS(
           SELECT 1 FROM pg_trigger WHERE tgname = 'video_enqueue_storage_cleanup')
      || ' migrations=' || (SELECT count(*) FROM drizzle.__drizzle_migrations)
      || ' videos='     || (SELECT count(*) FROM video)
      || ' endpoints='  || (SELECT count(*) FROM webhook_endpoint);"
# expect: trigger=true migrations=17 videos=<your count> endpoints=<your count>

# 5. Prove the trigger actually fires, on a throwaway row.
psql -d "$NEW" -tAc "
  DELETE FROM organization WHERE id = '<a disposable org id>';
  SELECT count(*) FROM storage_cleanup_job;"
# expect >= 1
```

Then point `DATABASE_URL` at `$NEW` and redeploy. Keep the old database until
you have confirmed uploads, playback and a deletion end to end.

Verified end to end during this review: a legacy-shaped database with one
organization and one video was dumped, restored into a freshly migrated one, and
the resulting database reported `trigger=true`, 17 applied migrations, and intact
rows — and a cascade delete on the restored data enqueued a cleanup job with the
two-hour deferral applied.

## What changed, and why

### Attempt ownership

Dispatching a transcode is not idempotent, and the dispatcher retries. If Modal
accepts a request and the response is lost, the retry used to spawn a **second
GPU container** for the same video. Now every dispatch mints an attempt id and
claims the row with one conditional `UPDATE`; a lost claim means no dispatch.
Callbacks and heartbeats must name their attempt, heartbeats extend its lease,
and a superseded attempt's callback is refused.

### The organization cap

It was doubly broken: **no caller ever passed one** (production was unlimited
regardless of config), and even supplied it did not hold — two claims for
*different* videos update different rows, so they never block each other under
READ COMMITTED and both read the same pre-state. Fixed with a `FOR UPDATE` lock
on the organization row taken in an **earlier statement**, which works because
READ COMMITTED takes a fresh snapshot per statement. Cap it with
`TRANSCODE_ORG_CONCURRENCY_CAP`.

### Uncertain dispatch outcomes

The transcoder starts work when it *accepts*. A network error, timeout or 5xx
therefore does not prove nothing is running, so those no longer mark the row
`failed` — the claim is left to expire and the sweeper reconciles. Only
definitive rejections (4xx, missing config, malformed envelope) fail the row.
Routes return 503 for the ambiguous case.

### Durable events (outbox)

`video.ready` and `video.failed` are written by the **same statement** as the
state change. Previously a process dying in between lost the event permanently:
the callback retry found the row already `ready`, the state guard ignored it, and
the tenant never learned their video was playable.

Delivery is **at-least-once** under a stable event id, so receivers can
deduplicate; exactly-once is not promised and cannot be. `webhook_delivery`
holds one leased row per endpoint with exponential backoff.

### Storage reclamation

Deleting a video soft-deletes the row and enqueues reclamation in one statement.
An `AFTER DELETE` trigger is the backstop for cascades from deleting an
organization or a user — paths no route handler can intercept. Nine hard-delete
call sites and both cascade foreign keys are now covered.

A job reaches `reclaimed` only once **writers have retired and a fresh listing
is empty**, and is re-verified later. One empty listing is not treated as proof:
a late writer could otherwise land after we looked and never be noticed.

### Maintenance

One runner shared by the Workers cron and `POST /api/internal/sweep`. The
scheduled handler previously ran only the transcode sweep, so a deployment with
the documented cron never retried a single webhook. Docker now has a
`maintenance` compose service, because a container has no cron equivalent.

## Verified

257 tests: 160 server (38 against real Postgres), 42 delivery, 40 setup,
9 player, 6 sdk. Typecheck and lint clean.

Integration suites read `TEST_DATABASE_URL` and skip cleanly when unset. Each
suite creates and migrates **its own database**, so CI needs no separate
migration step — verified by running the whole suite against a database with
zero tables (160/160 pass).

Three claims were checked by deliberately breaking the code and confirming the
test fails, rather than trusting a green run:

- **Two videos, one slot, concurrent:** without the organization lock both
  claims succeed (`got 2`); with it exactly one does.
- **Playback token restrictions:** without `algorithms`/`requiredClaims`, a
  correctly-signed HS384 token and an HS256 token with no `exp` are both
  **accepted** (`delivery/src/token-verify.test.ts` fails on both); with them,
  both are rejected.
- **Soft-delete guard:** the CI check fails on any `video` read that neither
  composes `notDeleted` nor carries an explicit exemption.

## Test isolation

Each suite creates and migrates its own database. Sharing one is not fixable by
tidier cleanup, because the maintenance passes are global by design:
`sendDueDeliveries` and `runObjectCleanup` claim whatever is due, not just what
the current file created, and `AFTER DELETE ON video` fires for every suite. A
shared database therefore makes test order significant — a suite that passes
alone can fail in a full run, which is what happened here.

Concurrency tests open an *additional* connection to the suite's existing
database via `connectTestDb`. They must not call `createTestDb`, which drops and
recreates the database and would destroy the rows mid-suite.

Every test sets up its own fixtures (`givenDeliveredEvent`), so any single test
passes in isolation — including the ones that previously relied on a neighbour,
such as `atomicWrite`'s idempotency case.

Database names carry a per-run suffix, so two concurrent test invocations cannot
drop each other's fixtures, and `close()` drops the suite database so runs do not
accumulate. **That suffix is not covered by a test**: the race it prevents is
timing-dependent, and forcing a shared name in two parallel runs did not
reproduce a failure. The fix removes a structural hazard; it is not empirically
demonstrated, unlike the guarantees listed above.

## Known gaps

- **No route-level tests for the delivery-log/replay endpoints** or for the
  callback → outbox → delivery path under the *full* app. The full app needs
  better-auth sessions to mount; the composition suite mounts the webhook router
  directly instead. Everything underneath is covered.
- **No dashboard UI for the delivery log.** `GET /api/webhooks/deliveries` and
  `POST /api/webhooks/deliveries/:id/replay` exist; `web/app/dashboard/webhooks`
  does not render them yet.
- **Reclaiming a soft-deleted video's bytes does not revoke playback.** The
  delivery worker never reads the database — it verifies the JWT and reads R2
  metadata — so existing signed URLs keep working until the bytes are gone.
  `deleted` means "removed from the library", not "access revoked". Revocation
  needs a delivery-side check and is not implemented.
- **Soft-deleted videos still count toward `GET /api/usage` storage** until
  reclaimed. Arguably correct (you are still paying for them) but worth stating.
- **Eleven non-lifecycle webhook events still dispatch directly**
  (`video.uploaded`, `subtitle.*`, `chapters.*`, `video.deleted`). They get no
  retries, and their preceding state change is **not** atomic with event
  creation — a strictly weaker guarantee than `video.ready`/`video.failed`.
  Converting `dispatchWebhook` to enqueue would add retries but would not make
  those changes atomic.
- **Modal dedupe is not airtight.** `modal.Dict` is not an atomic
  compare-and-set, and the endpoint proceeds (loudly) if the store is
  unreachable, because failing closed would stop all transcoding on a Dict
  outage. The API-side claim is the primary guard; the Dict is defence in depth.
- **No hard spending limit.** Concurrency is bounded; the total bill is not.
- **`tonemap_cuda` is probably unavailable** in the Modal image (apt ffmpeg,
  which needs NPP for that filter), so HDR sources likely fail. Pre-existing.
- **`transcoding/` has unpinned pip dependencies** and no lockfile.

## Not attempted (later releases)

Per the agreed roadmap these were explicitly deferred, not forgotten:

- **Release 2 — integration:** publish `@openvod/uploader` and `@openvod/player`
  to npm, make the dashboard use them, migration guide from Mux. Both packages
  are still 404 on npm, and the landing page says so.
- **Release 3 — cost control:** encoding presets, per-video measured time/bytes.
- **Release 4 — economics artifact:** the cost calculator, with benchmarks
  rather than assumed figures. Mux's 100k free delivery minutes and $20 credit
  must be modelled alongside R2's free tier or the comparison is misleading.
- **Release 5 — portability:** additional storage backends. Worth noting the
  transcoder (`transcoding/main.py`) and delivery worker
  (`delivery/src/index.ts`) have **their own** storage paths — a hardcoded R2
  endpoint and a native R2 binding — so an API-only change cannot make the
  system provider-independent.
- **Three SaaS pilots.** Still the thing that should decide priorities.
