# Deploying OpenVOD

First-run: **[README](../README.md)** or `./scripts/bootstrap.sh` (Cloudflare +
Modal login, R2 buckets, deploys). You still paste R2 S3 keys from the
dashboard — Wrangler cannot mint them.

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
pnpm install
scripts/setup.sh          # writes server/.dev.vars + delivery/.dev.vars
pnpm db:push              # or drizzle-kit migrate
cd server && wrangler deploy
cd ../delivery && wrangler deploy
cd ../transcoding && modal deploy main.py
```

Frontend: import `web/` into Vercel and set `NEXT_PUBLIC_API_BASE_URL`,
`NEXT_PUBLIC_AUTH_BASE_URL`, and `NEXT_PUBLIC_FRONTEND_URL`.

Job sweeper: set `SWEEP_ENABLED=true` and uncomment `triggers.crons` in
`server/wrangler.jsonc`, or call `POST /api/internal/sweep` with
`INTERNAL_SWEEP_SECRET`.

## Path B — Docker API + web, Workers delivery

```bash
scripts/setup.sh          # choose "docker" so DB_DRIVER=pg
docker compose up -d      # postgres :5433, api :8787, web :3000
cd delivery && wrangler deploy
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
worker verifies them with the **same** `JWT_SECRET`. `scripts/setup.sh`
mirrors that secret into `delivery/.dev.vars`; `verify-env.sh` warns if they
diverge.

## Modal

Create secrets `r2-creds` and optional `groq-creds`, then `modal deploy main.py`.
Set `ALLOWED_CALLBACK_HOSTS` to your API host and `ALLOWED_SOURCE_BUCKETS` to
the raw bucket name. The API needs `MODAL_WEBHOOK_URL` and
`TRANSCODE_INGEST_SECRET`.
