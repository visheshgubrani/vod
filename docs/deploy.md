# Deploying ClipMux

First-run: **[README](../README.md)** or `./scripts/bootstrap.sh` — the
launcher installs Node/pnpm (nvm) when missing, then the interactive wizard
writes `.dev.vars` for your architecture choices; the opt-in `--deploy`
phase handles Cloudflare + Modal login, R2 buckets/CORS, deploys and secret
uploads. You still paste R2 S3 keys from the dashboard — Wrangler cannot
mint them.

This page is the deployment flow after those accounts exist. What a
deployment can and cannot vary — Postgres, transcoder provider, dispatch
transport, rate-limit store, analytics on/off; delivery and storage are
**fixed**, and the API is Node — is the canonical reference in
[deployment-shapes.md](./deployment-shapes.md).

## Two stacks, two files

| File | Purpose | Configuration |
| --- | --- | --- |
| `docker-compose.dev.yml` (project `clipmux-dev`) | Local development infrastructure only: `postgres` (:5433) and `redis` (:6382). No API or web service — application code runs on the host. | `server/.dev.vars` |
| `docker-compose.yml` (project `clipmux`) | The deployment stack for end users, and how we test a deployment: `postgres` and `redis` (both internal-only), `api`, `web`, plus the `migrate` (`tools`) and `transcoder` (`transcoder`) profiles. | `.env` at the repo root |

`server/.dev.vars` is **development-only** (`pnpm dev`, migrations, tests). A
Compose deployment is configured entirely by `.env` at the repo root —
Compose reads it twice, for `${...}` interpolation and as the environment of
the `api` container. Never commit `.env`.

## Compose deployment

```bash
cp .env.example .env      # secrets, public URLs, R2 buckets — never commit it
pnpm docker:migrate       # one-shot migrate service (profile "tools")
pnpm docker:up            # docker compose up -d
```

- API: `http://localhost:8787` · dashboard: `http://localhost:3000`. Both are
  bound to `127.0.0.1`; put a reverse proxy in front for public traffic.
- Postgres and Redis are internal to the stack — no host port, so they cannot
  collide with the dev Postgres on :5433 or be reached from the network. Set
  `DATABASE_URL`/`REDIS_URL` in `.env` to use your own servers instead.
- `NEXT_PUBLIC_*` are baked into the dashboard bundle at build time; rebuild
  after changing them: `pnpm docker:build && pnpm docker:up`.
- Every service that can come from a registry declares
  `image: ${CLIPMUX_*_IMAGE:-<local-name>}` alongside `build:`, so
  `pnpm docker:build` and `docker compose pull` both work.
- Lifecycle: `pnpm docker:logs` (follow), `pnpm docker:down` (stop),
  `pnpm docker:reset` (stop and delete volumes).

`pnpm dev` and `docker compose up -d` both want ports 8787/3000 — run the dev
setup or the deployment stack, not both.

Run **exactly one** API instance with `SWEEP_ENABLED=true` (the default).
Additional replicas set `SWEEP_ENABLED=false`. There is no leader election.

### Migrations

| Context | Command |
| --- | --- |
| Development | `pnpm db:migrate` (reads `server/.dev.vars`) |
| Deployment | `pnpm docker:migrate` — the one-shot `migrate` service |

The `api` container also migrates on boot for zero-touch installs, but that
runs once per replica and races if you scale out; prefer the one-shot service.
Committed migrations are authoritative: `db:push` derives changes from the
TypeScript schema and cannot create the hand-written objects, in particular the
`AFTER DELETE` trigger that queues a deleted video's bytes for reclamation.

### Profiles

- **`migrate`** (profile `tools`) — `pnpm docker:migrate`, or
  `docker compose run --rm migrate`. Idempotent; safe to run every deploy.
- **`transcoder`** (profile `transcoder`) — the self-hosted agent, opt-in:
  `docker compose --profile transcoder up -d`, with
  `TRANSCODE_PROVIDER=self-hosted`. See
  [self-hosted-transcoding.md](./self-hosted-transcoding.md).

## Minimum Cloudflare surface

1. Two R2 buckets (raw uploads + transcoded output) with S3 CORS allowing your
   dashboard / upload origin.
2. The **delivery** Worker bound to the transcoded bucket (`delivery/wrangler.jsonc`).

Delivery is fixed: there is no Node delivery worker, so the Compose stack has
no service for it. Add a custom domain after first deploy — the wrangler config
ships with a commented example (`media.example.com`); it does not bind a
production hostname for you.

## Path A — Node API + Cloudflare delivery

```bash
./scripts/bootstrap.sh --target dev   # wizard: bundled or existing Postgres, R2 keys
pnpm db:migrate           # against DATABASE_URL; db:push cannot create the cleanup trigger
cd delivery && pnpm exec wrangler deploy
cd transcoding && modal deploy main.py
pnpm dev                  # Node API :8787 + dashboard :3000
```

`DATABASE_URL` is any `postgresql://` connection string. A Neon URL is ordinary
hosted Postgres — there is no dedicated driver or wizard choice. Frontend:
import `web/` into Vercel and set `NEXT_PUBLIC_API_BASE_URL`,
`NEXT_PUBLIC_AUTH_BASE_URL`, and `NEXT_PUBLIC_FRONTEND_URL`, or run the Docker
web image.

The Node API starts in-process maintenance after listen when `SWEEP_ENABLED=true`
(the default). Additional replicas set `SWEEP_ENABLED=false`. Manual sweeps
target that designated instance: `POST /api/internal/sweep` with
`INTERNAL_SWEEP_SECRET`.

## Path B — Docker Compose (API + dashboard), Workers delivery

```bash
cp .env.example .env      # deployment config — never commit it
pnpm docker:migrate
pnpm docker:up            # api :8787, web :3000, postgres + redis internal
cd delivery && pnpm exec wrangler deploy
cd transcoding && modal deploy main.py
```

Then set `DELIVERY_URL` in `.env` to the deployed worker origin (no trailing
slash) and restart the API. Rebuild the web image after changing
`NEXT_PUBLIC_*` (they are baked at build time).

## Migrating from the archived API Worker

The API Worker runtime is archived at `archive/workers-api` / tag
`v0-workers-checkpoint`. Existing installations:

1. Deploy the updated **delivery** worker first (playback ingest endpoint +
   `ANALYTICS_INGEST_SECRET`).
2. Configure Node against the **existing** database. No data migration or
   reset is required.
3. Stop the old API Worker’s cron.
4. Switch API traffic and callback URLs to Node.
5. Retire the old API Worker deployment.

Preserve database contents, R2 objects, dataset names, and playback secrets
throughout. `DB_DRIVER` is obsolete: if it is still set, Node starts and
reports an advisory — remove it.

## Health

- API liveness: `GET /health` → `ok`
- BYOK flags (no secrets): `GET /health/config`
  - Core (`ready`): database, storage, transcoder, auth
  - Advisory: analytics, AI, **delivery** (`DELIVERY_URL`)
  - `deployment`: the resolved shape — runtime, `dbTransport`,
    `rateLimitStore`, `transcodeProvider`, `selfHostedEnabled`,
    `modalDispatch`, `analyticsWrite`, `analyticsRead`, `uploadsEnabled`,
    `deliveryRuntime`, `deliveryUrl`. Contract:
    [deployment-shapes.md](./deployment-shapes.md).
- Delivery worker: `GET /health` and `GET /health/config`
- Modal: `GET /healthz`
- Dashboard: `/setup` and the cluster-health strip consume `/health/config`

`./scripts/bootstrap.sh --check` checks the selected target's configuration
without printing secrets (`--target deploy` checks the root `.env`; when both
exist, say which) and optionally probes `/health/config`.

## JWT parity

The API mints playback tokens (`iss: clipmux`, `aud: playback`). The delivery
worker verifies them with the **same** `JWT_SECRET`. The bootstrap wizard
mirrors that secret into `delivery/.dev.vars` (the `dev` target);
`./scripts/bootstrap.sh --check --target dev` warns if they diverge. A
delivery-worker deployment sets it with `cd delivery && pnpm exec wrangler secret put JWT_SECRET`;
a Compose deployment sets it in `.env`.

## Modal

Create secrets `clipmux-creds` and optional `clipmux-groq-creds`, then
`modal deploy main.py`. Set `ALLOWED_CALLBACK_HOSTS` to your API host and
`ALLOWED_SOURCE_BUCKETS` to the raw bucket name. The API needs
`MODAL_WEBHOOK_URL` and `TRANSCODE_INGEST_SECRET` (the primary name — the legacy
`MODAL_WEBHOOK_SECRET` alias is accepted but loses to it in both directions).

`./scripts/bootstrap.sh --deploy` creates both secrets for you, deriving every
value from the selected configuration target: `R2_BUCKET_NAME` from
`TRANSCODED_BUCKET_NAME`, `ALLOWED_SOURCE_BUCKETS` from `RAW_BUCKET_NAME`, and
`ALLOWED_CALLBACK_HOSTS` from `BACKEND_URL` (the host the API actually builds
callbacks from). The creds secret is rewritten on every deploy, so editing the
target file and re-running `--deploy` is how a bucket or callback host is
changed. The old `r2-creds` / `groq-creds` names are detected and offered for
deletion.

Local API users must supply a publicly reachable `BACKEND_URL`. Automatic
tunnels are deferred.

## Background maintenance (required for correctness, not optional)

One maintenance pass does three things:

1. **Transcode sweeps** — retries or fails videos stuck `processing`/`uploading`.
2. **Webhook retries** — drains the `event_outbox` and retries due deliveries
   with backoff. `video.ready`/`video.failed` are written in the same statement
   as the state change, so they cannot be lost between the two.
3. **Storage reclamation** — deletes the bytes of deleted videos, once any
   writer that could still legitimately write has retired.

**If it does not run, nothing errors.** Webhooks are simply never retried, and
deleted videos keep costing storage forever. `GET /health/config` reports
`maintenance.enabled` and adds an advisory when it is off.

The Node API starts an in-process scheduler after listen when a database is
configured and `SWEEP_ENABLED=true` (the default). It runs an initial
asynchronous pass, then schedules the next pass after completion using
`MAINTENANCE_INTERVAL_SECONDS` (default 900; must be a positive integer in 1–2147483 or it falls back to 900). Timer and authenticated manual
sweeps share a process-local single-flight runner, so they cannot overlap. A
failed pass does not stop subsequent scheduling. Shutdown stops scheduling and
lets active work finish within the existing shutdown deadline.

Run **exactly one** scheduler-enabled API instance. Additional replicas set
`SWEEP_ENABLED=false`. Manual sweeps (`POST /api/internal/sweep` with
`INTERNAL_SWEEP_SECRET`) must target that designated instance. Distributed
scheduling and leader election are deferred.

```bash
curl -X POST http://localhost:8787/api/internal/sweep \
  -H "x-sweep-secret: $INTERNAL_SWEEP_SECRET"
# -> { ok, stats, deliveries, cleanup, durationMs }
```

A non-zero `cleanup.jobsReclaimed` means deleted videos had their bytes freed.
`cleanup.jobsFailed` non-zero means objects could not be deleted after repeated
attempts and need attention — that is deliberately visible rather than silent.
