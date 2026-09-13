# Deploying OpenVOD

First-run: **[README](../README.md)** or `./scripts/bootstrap.sh` — the
launcher installs Node/pnpm (nvm) when missing, then the interactive wizard
writes `.dev.vars` for your architecture choices; the opt-in `--deploy`
phase handles Cloudflare + Modal login, R2 buckets/CORS, deploys and secret
uploads. You still paste R2 S3 keys from the dashboard — Wrangler cannot
mint them.

This page is the deployment flow after those accounts exist. What a
deployment can and cannot vary — API runtime, Postgres transport, transcoder
provider, dispatch transport, rate-limit store; delivery and storage are
**fixed** — is the canonical reference in
[deployment-shapes.md](./deployment-shapes.md).

## Two stacks, two files

| File | Purpose | Configuration |
| --- | --- | --- |
| `docker-compose.dev.yml` (project `openvod-dev`) | Local development infrastructure only: `postgres` (:5433) and `redis` (:6379). No API or web service — application code runs on the host. | `server/.dev.vars` |
| `docker-compose.yml` (project `openvod`) | The deployment stack for end users, and how we test a deployment: `postgres` and `redis` (both internal-only), `api`, `maintenance`, `web`, plus the `migrate` (`tools`) and `transcoder` (`transcoder`) profiles. | `.env` at the repo root |

`server/.dev.vars` is **development-only** (`pnpm dev`, `pnpm dev:workers`,
migrations, tests). A Compose deployment is configured entirely by `.env` at
the repo root — Compose reads it twice, for `${...}` interpolation and as the
environment of the `api`/`maintenance` containers. Never commit `.env`.

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
  `image: ${OPENVOD_*_IMAGE:-<local-name>}` alongside `build:`, so
  `pnpm docker:build` and `docker compose pull` both work.
- Lifecycle: `pnpm docker:logs` (follow), `pnpm docker:down` (stop),
  `pnpm docker:reset` (stop and delete volumes).

`pnpm dev` and `docker compose up -d` both want ports 8787/3000 — run the dev
setup or the deployment stack, not both.

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
3. Optional: the API Worker (you can run the API in the Compose stack instead).

Delivery is fixed: there is no Node delivery worker, so the Compose stack has
no service for it. Add a custom domain after first deploy — the wrangler configs
ship with commented examples (`api.example.com` / `media.example.com`); they do
not bind a production hostname for you.

## Path A — Cloudflare Workers

```bash
./scripts/bootstrap.sh     # wizard: choose the Workers runtime, paste R2/Neon keys
pnpm db:migrate           # against the Neon URL; db:push cannot create the cleanup trigger
cd server && pnpm exec wrangler deploy
cd ../delivery && pnpm exec wrangler deploy
cd ../transcoding && modal deploy main.py
```

Set `DB_DRIVER=neon-http` (the runtime refuses to start with `pg`, and
`REDIS_URL` is likewise fatal there — use Upstash REST or the in-memory
limiter). Frontend: import `web/` into Vercel and set
`NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_AUTH_BASE_URL`, and
`NEXT_PUBLIC_FRONTEND_URL`.

Job sweeper: set `SWEEP_ENABLED=true` and uncomment `triggers.crons` in
`server/wrangler.jsonc`, or call `POST /api/internal/sweep` with
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
- Delivery worker: `GET /health`
- Modal: `GET /healthz`
- Dashboard: `/setup` and the cluster-health strip consume `/health/config`

`./scripts/bootstrap.sh --check` checks `.dev.vars` without printing secrets and
optionally probes `/health/config`.

## JWT parity

The API mints playback tokens (`iss: openvod`, `aud: playback`). The delivery
worker verifies them with the **same** `JWT_SECRET`. The bootstrap wizard
mirrors that secret into `delivery/.dev.vars`; `./scripts/bootstrap.sh --check`
warns if they diverge. A Workers deployment sets it with
`wrangler secret put JWT_SECRET`; a Compose deployment sets it in `.env`.

## Modal

Create secrets `r2-creds` and optional `groq-creds`, then `modal deploy main.py`.
Set `ALLOWED_CALLBACK_HOSTS` to your API host and `ALLOWED_SOURCE_BUCKETS` to
the raw bucket name. The API needs `MODAL_WEBHOOK_URL` and
`TRANSCODE_INGEST_SECRET` (the primary name — the legacy `MODAL_WEBHOOK_SECRET`
alias is accepted but loses to it in both directions).

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

### Workers

`server/wrangler.jsonc` ships a cron trigger (`*/15 * * * *`) and the handler
runs maintenance when `SWEEP_ENABLED=true`:

```bash
pnpm exec wrangler secret put SWEEP_ENABLED   # value: true
pnpm exec wrangler deploy
```

Alternatively schedule `POST /api/internal/sweep` yourself with the
`INTERNAL_SWEEP_SECRET` header — it calls the same runner.

### Compose

`docker-compose.yml` includes a `maintenance` service that calls the endpoint on
an interval (`MAINTENANCE_INTERVAL_SECONDS`, default 900). Set
`INTERNAL_SWEEP_SECRET` in `.env`; without it the service logs a loud warning
and deliberately does nothing rather than pretend.

```bash
pnpm docker:up
pnpm docker:logs          # confirm maintenance is actually running
```

### Verifying it ran

```bash
curl -X POST http://localhost:8787/api/internal/sweep \
  -H "x-sweep-secret: $INTERNAL_SWEEP_SECRET"
# -> { ok, stats, deliveries, cleanup, durationMs }
```

A non-zero `cleanup.jobsReclaimed` means deleted videos had their bytes freed.
`cleanup.jobsFailed` non-zero means objects could not be deleted after repeated
attempts and need attention — that is deliberately visible rather than silent.
