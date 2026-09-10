# Deploying OpenVOD

First-run: **[README](../README.md)** or `./scripts/bootstrap.sh` — the
launcher installs Node/pnpm (nvm) when missing, then the interactive wizard
writes `.dev.vars` for your architecture choices; the opt-in `--deploy`
phase handles Cloudflare + Modal login, R2 buckets/CORS, deploys and secret
uploads. You still paste R2 S3 keys from the dashboard — Wrangler cannot
mint them.

This page is the architecture split after those accounts exist.

OpenVOD is **hybrid by design**:

| Piece | Wrangler (default) | Docker / Node |
| --- | --- | --- |
| Control-plane API | Cloudflare Worker (`DB_DRIVER=neon-http`) | Node container (`DB_DRIVER=pg`) |
| Dashboard | Vercel or the `web` image | `web` image in Compose |
| Postgres | Neon (or any Postgres URL) | Compose `postgres` service |
| **Delivery** (signed HLS/DASH) | Cloudflare Worker | **Same Worker — there is no Node delivery** |
| Object storage | Cloudflare R2 | Cloudflare R2 |
| Transcoding | Modal GPU | Modal GPU |

`docker compose up -d` boots **Postgres + API + dashboard**. It does not serve
playback. You still deploy the delivery worker and point `DELIVERY_URL` at it.

Storage today is **Cloudflare R2** (S3 API with an account-id endpoint). A
generic `S3_ENDPOINT` is not implemented yet.

## Minimum Cloudflare surface

1. Two R2 buckets (raw uploads + transcoded output) with S3 CORS allowing your
   dashboard / upload origin.
2. The **delivery** Worker bound to the transcoded bucket (`delivery/wrangler.jsonc`).
3. Optional: the API Worker (you can run the API in Docker instead).

Add a custom domain after first deploy. The wrangler configs ship with
commented examples (`api.example.com` / `media.example.com`) — they do not
bind a production hostname for you.

## Path A — Wrangler default

```bash
./scripts/bootstrap.sh     # wizard: choose the Workers runtime, paste R2/Neon keys
pnpm db:migrate           # committed migrations; db:push cannot create the cleanup trigger
cd server && pnpm exec wrangler deploy
cd ../delivery && pnpm exec wrangler deploy
cd ../transcoding && modal deploy main.py
```

Frontend: import `web/` into Vercel and set `NEXT_PUBLIC_API_BASE_URL`,
`NEXT_PUBLIC_AUTH_BASE_URL`, and `NEXT_PUBLIC_FRONTEND_URL`.

Job sweeper: set `SWEEP_ENABLED=true` and uncomment `triggers.crons` in
`server/wrangler.jsonc`, or call `POST /api/internal/sweep` with
`INTERNAL_SWEEP_SECRET`.

## Path B — Docker API + web, Workers delivery

```bash
./scripts/bootstrap.sh     # wizard: choose the Compose runtime so DB_DRIVER=pg
docker compose up -d      # postgres :5433, api :8787, web :3000
cd delivery && pnpm exec wrangler deploy
cd transcoding && modal deploy main.py
```

Compose reads `server/.dev.vars` when present and forces `DB_DRIVER=pg` plus
container DNS for Postgres. Rebuild the web image after changing
`NEXT_PUBLIC_*` (they are baked at build time).

On Docker, schedule the sweeper yourself:

```bash
curl -X POST http://localhost:8787/api/internal/sweep \
  -H "Authorization: Bearer $INTERNAL_SWEEP_SECRET"
```

## Health

- API liveness: `GET /health` → `ok`
- BYOK flags (no secrets): `GET /health/config`
  - Core (`ready`): database, storage, transcoder, auth
  - Advisory: analytics, AI, **delivery** (`DELIVERY_URL`)
- Delivery worker: `GET /health`
- Modal: `GET /healthz`
- Dashboard: `/setup` and the cluster-health strip consume `/health/config`

`scripts/verify-env.sh` checks `.dev.vars` without printing secrets and
optionally probes `/health/config`.

## JWT parity

The API mints playback tokens (`iss: openvod`, `aud: playback`). The delivery
worker verifies them with the **same** `JWT_SECRET`. The bootstrap wizard
mirrors that secret into `delivery/.dev.vars`; `verify-env.sh` warns if they
diverge.

## Modal

Create secrets `r2-creds` and optional `groq-creds`, then `modal deploy main.py`.
Set `ALLOWED_CALLBACK_HOSTS` to your API host and `ALLOWED_SOURCE_BUCKETS` to
the raw bucket name. The API needs `MODAL_WEBHOOK_URL` and
`TRANSCODE_INGEST_SECRET`.

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

### Docker

`docker-compose.yml` includes a `maintenance` service that calls the endpoint on
an interval. Set `INTERNAL_SWEEP_SECRET` in `server/.dev.vars`; without it the
service logs a loud warning and deliberately does nothing rather than pretend.

```bash
docker compose up -d
docker compose logs -f maintenance   # confirm it is actually running
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
