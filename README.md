# OpenVOD

**Open-source, self-hosted video infrastructure. Bring your own keys.**

Paste your Cloudflare R2 credentials and a Modal endpoint and get Mux-style
HLS/DASH ingestion: multipart uploads, GPU transcoding, signed playback URLs,
optional AI subtitles & chapters, tenant webhooks and usage analytics — on
accounts you control.

## Why OpenVOD

- **BYOK**: Cloudflare R2 for storage, Modal for GPU transcoding, your Postgres
  for metadata.
- **Mux-style DX**: upload tokens → direct-to-R2 multipart, typed transcode
  callbacks, playback JWTs with UA/domain binding.
- **Open**: Apache-2.0. Optional integrations (QStash, Upstash Redis, Workers
  Analytics Engine) have a fallback or a documented no-op.

## Run it or develop it

| I want to… | Start here |
| --- | --- |
| **Read the docs** — setup, integration guides, API reference | [docs site](docs-site) — `pnpm --filter openvod-docs dev`, or the built site |
| **Run OpenVOD** on my own accounts | [Setup](#setup) below, then [docs/deploy.md](docs/deploy.md) |
| **Integrate it into my app** (Next.js, Vite, Nuxt, SvelteKit, Node) | [docs-site/content/docs/integrations](docs-site/content/docs/integrations) |
| **See what differs per install** (API runtime, Postgres transport, transcoder, rate-limit store) | [docs/deployment-shapes.md](docs/deployment-shapes.md) |
| **Develop OpenVOD** — change the code | [CONTRIBUTING.md](CONTRIBUTING.md) |

The `docs-site/` Fumadocs app is the developer-facing reference: quickstart,
framework integration guides, the full `/v1` API reference, an error-code
catalogue and the configuration reference. This README remains the shortest path
to a running installation; the docs site is where the detail lives.

**Fastest path to a deployment:** `./scripts/bootstrap.sh` — installs Node +
pnpm when missing (via nvm), installs workspace deps, and runs an interactive
wizard that writes `server/.dev.vars` + `delivery/.dev.vars` (local
development config) for the architecture you pick (API runtime, Postgres,
queue, rate limiting). Re-run with `--deploy` when you are ready: Cloudflare +
Modal logins, R2 buckets/CORS, worker + GPU pipeline deploys and secret
uploads. You still paste an **R2 S3 API token** (Wrangler cannot mint those)
and a **Postgres URI** unless you deploy with Compose, which runs its own
Postgres.

**Fastest path for a contributor:** `pnpm install && pnpm dev:infra &&
pnpm db:migrate && pnpm dev` — Postgres + Redis in Docker, then the API on the
Node runtime (`:8787`) and the dashboard (`:3000`) on the host. Copy
`server/.dev.vars.example` to `server/.dev.vars` first: `pnpm db:migrate` reads
`DATABASE_URL` from it (default: the `dev:infra` Postgres).

---

## Prerequisites

Create these **before** you clone and fill env files. The dashboard cannot mint
uploads or play video until they exist.

The canonical, expanded version of this table — with the exact R2 CORS policy the
raw bucket needs, and what each key unlocks — is the
[Quickstart](docs-site/content/docs/quickstart.mdx).

| You need | Why | Where |
| --- | --- | --- |
| [Cloudflare](https://dash.cloudflare.com/sign-up) account | R2 buckets, the **delivery** Worker (always), and the API Worker on the Workers path | Free tier is enough to start |
| Two **R2** buckets | Raw uploads vs transcoded HLS/DASH | R2 → Create bucket |
| An **R2 API token** (S3 credentials) | API, Modal, and uploads talk to R2 over the S3 API | R2 → Manage R2 API Tokens |
| Cloudflare login | Deploy the delivery worker (always) and the API worker (Workers path) | wrangler is a pinned local devDependency — `pnpm exec wrangler login`, never a global `npx wrangler` |
| [Postgres](https://neon.tech) **or** Docker | Metadata, auth, video rows | Neon serverless URL, or the `postgres` service inside the Compose stack |
| [Modal](https://modal.com) account | GPU transcoding (FFmpeg / Shaka / Whisper) | the `--deploy` phase installs the Modal CLI (uv/pipx/venv) and runs `modal setup` |
| Node 22 + pnpm 12 | Workspace install / `wrangler` / dashboard | `./scripts/bootstrap.sh` installs both via nvm when missing |

**Delivery and storage are fixed, not choices.** Signed playback is always the
Cloudflare Worker in `delivery/` in front of your R2 transcoded bucket — there
is no Node delivery, and the Compose stack deliberately has no service for it.
The API runtime, Postgres transport, transcoder provider, dispatch transport
and rate-limit store *are* choosable per deployment: see
[docs/deployment-shapes.md](docs/deployment-shapes.md).

---

## Keys you will collect

Put these in `server/.dev.vars` for local development, or in `.env` at the repo
root for a Docker Compose deployment (`cp .env.example .env`). The bootstrap
wizard writes the `.dev.vars` pair and mirrors `JWT_SECRET` into
`delivery/.dev.vars`. Never commit `.env` or `.dev.vars` — only the `*.example`
templates are tracked.

The two canonical tables — every variable, what it is, and exactly where to get
it — live in the docs site:

- [Keys you will collect → Required](docs-site/content/docs/quickstart.mdx) —
  `ACCOUNT_ID`, the R2 S3 key pair, both bucket names, `DATABASE_URL`,
  `DB_DRIVER`, `MODAL_WEBHOOK_URL`, `TRANSCODE_INGEST_SECRET`, `JWT_SECRET`,
  `BETTER_AUTH_SECRET`, `DELIVERY_URL` and the three public origins.
- [Keys you will collect → Optional](docs-site/content/docs/quickstart.mdx) —
  `GROQ_API_KEY`, `CLOUDFLARE_ANALYTICS_TOKEN`, OAuth, `QSTASH_TOKEN`,
  `REDIS_URL`, Upstash.

[`server/.dev.vars.example`](server/.dev.vars.example) and
[`.env.example`](.env.example) remain the authoritative, commented templates —
they are what the wizard and Compose actually read. The full environment
reference, including which variables are fatal on which runtime, is
[docs-site/content/docs/configuration.mdx](docs-site/content/docs/configuration.mdx).

---

## Setup

The wizard configures **local development** files (`server/.dev.vars`,
`delivery/.dev.vars`); deploying is a separate step, and the Compose stack is
configured by `.env` at the repo root. The same command configures either path:
it checks/installs Node + pnpm (nvm) when missing, installs workspace deps, then
runs an interactive wizard that asks how you want to run the API —
**Cloudflare Workers** (default, `DB_DRIVER=neon-http`) or **Node via Docker
Compose** (`pg`) — and which optional services to enable: **QStash** queueing
(default: direct HTTP to Modal) and a **rate-limit store** (default: in-memory;
Upstash on Workers, `REDIS_URL` on Node).

```bash
./scripts/bootstrap.sh                     # interactive configure (writes .dev.vars)
./scripts/bootstrap.sh --force             # regenerate; unrelated keys preserved
./scripts/bootstrap.sh --answers env.json  # headless configure (see --help)
./scripts/bootstrap.sh --deploy            # provision & deploy: CF + Modal logins,
                                           # R2 buckets/CORS, pipeline + worker deploys
./scripts/bootstrap.sh --check [api-url]   # verify .dev.vars without printing secrets
```

You will paste two things from dashboards (the CLIs cannot create them):

1. **R2 S3 API token** — [Manage API Tokens](https://dash.cloudflare.com/?to=/:account/r2/api-tokens), Object Read & Write on both buckets.
2. **DATABASE_URL** — [Neon](https://console.neon.tech) (skip if you chose the Compose runtime).

Then open `/setup` on the dashboard. The rest of this section is the same
flow if you prefer to do it by hand.

### 1. Create two R2 buckets

In [Cloudflare dashboard → R2](https://dash.cloudflare.com/?to=/:account/r2):

1. Create a **raw** bucket (uploads). Example name: `openvod-raw`.
2. Create a **transcoded** bucket (playback output). Example name: `openvod-transcoded`.

On the **raw** bucket, add an [S3 CORS policy](https://developers.cloudflare.com/r2/buckets/cors/)
so the browser can `PUT` presigned parts. Settings → CORS policy:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add your production dashboard origin to `AllowedOrigins` when you deploy the
web app. `ETag` must be exposed or multipart complete fails.

Create the R2 API token (table above). You now have `ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and two bucket names.

### 2. Postgres

- **Workers path:** create a [Neon](https://neon.tech) project (or any
  Postgres that accepts `postgresql://…`). Copy `DATABASE_URL`.
- **Compose deployment:** skip this — the stack runs its own Postgres, and
  `DATABASE_URL` may be left blank in `.env`.

### 3. Modal account

```bash
pip install modal
modal setup          # browser login
```

You do **not** have a webhook URL yet. That appears after `modal deploy` in
step 6.

### 4. Clone and write env files

```bash
git clone https://github.com/visheshgubrani/vod.git
cd vod
./scripts/bootstrap.sh      # toolchain check + interactive wizard
./scripts/bootstrap.sh --check
```

The wizard writes `server/.dev.vars` and `delivery/.dev.vars` (same
`JWT_SECRET`; secrets are generated locally and files are chmod 600). By hand:
`cp server/.dev.vars.example server/.dev.vars` and the same for
`delivery/.dev.vars`, plus `cp web/.env.example web/.env` for the dashboard.

Those are **local development** files — `pnpm dev`, `pnpm dev:workers`,
migrations and tests read `server/.dev.vars`. A Docker Compose **deployment**
is configured by `.env` at the repo root instead:

```bash
cp .env.example .env      # deployment config: secrets, public URLs, R2 buckets
```

`.env.example` documents every key. Leave `DATABASE_URL`/`REDIS_URL` blank to
use the stack's own Postgres and Redis; set them to point at your own servers.
The two files are not kept in sync because they configure different things —
see [docs/deployment-shapes.md](docs/deployment-shapes.md).

Leave `MODAL_WEBHOOK_URL` / `DELIVERY_URL` blank until the deploys in the
next steps, then paste them in.

### 5. Point the delivery worker at your transcoded bucket

Edit `delivery/wrangler.jsonc` and set `r2_buckets[0].bucket_name` to
**your** transcoded bucket (the file ships `transcoded-bucket` as a
placeholder):

```jsonc
"r2_buckets": [
  { "binding": "TRANSCODED_BUCKET", "bucket_name": "openvod-transcoded" }
]
```

Then:

```bash
cd delivery
pnpm exec wrangler login    # pinned local devDependency — never npx (fetches latest)
pnpm exec wrangler deploy
```

Copy the `*.workers.dev` URL (or attach a custom domain — examples are
commented in the wrangler file). Set `DELIVERY_URL` to that origin with **no
trailing slash** — in `server/.dev.vars` for local development, or in the root
`.env` for a Compose deployment. It is the single delivery base URL: playback
URLs and the transcode completion callback both read it.

### 6. Deploy the API (pick one)

**Path A — Cloudflare Workers (default)**

```bash
cd server
pnpm exec wrangler deploy    # uses .dev.vars locally; for production:
# pnpm exec wrangler secret bulk <secrets.json>   # ./scripts/bootstrap.sh --deploy does this for you
```

Set `DB_DRIVER=neon-http`. After deploy, set `BACKEND_URL` /
`BETTER_AUTH_URL` to the Worker URL.

**Path B — Docker Compose (API + dashboard + Postgres + Redis)**

```bash
cp .env.example .env         # deployment config — never commit it
pnpm docker:migrate          # one-shot migrate service (profile "tools")
pnpm docker:up               # or: docker compose up -d
```

API: `http://localhost:8787` · dashboard: `http://localhost:3000` (both bound
to `127.0.0.1`; put a reverse proxy in front for public traffic). Postgres and
Redis are internal to the stack and are **not** published on host ports.
Rebuild the web image if you change `NEXT_PUBLIC_*` (they are baked at build
time):

```bash
pnpm docker:build && pnpm docker:up
```

Still deploy **delivery** (step 5). Compose does not include it.

Apply the schema:

- **development:** `pnpm db:migrate` (reads `server/.dev.vars`)
- **deployment:** `pnpm docker:migrate` (the one-shot `migrate` service). The
  `api` container also migrates on boot for zero-touch installs, but that races
  when you run several replicas — prefer the one-shot service.

Use `db:migrate`, not `db:push`. `push` derives the schema from the TypeScript
definitions, so it cannot create the hand-written objects in the migrations — in
particular the `AFTER DELETE` trigger that queues a deleted video's bytes for
reclamation. A database built with `push` leaks storage silently.

### 7. Deploy the transcoder to Modal

Create secrets in **your** Modal workspace. `R2_BUCKET_NAME` is the
**transcoded** bucket (outputs). `ALLOWED_SOURCE_BUCKETS` is the **raw**
bucket. `TRANSCODE_INGEST_SECRET` must match the API.
`./scripts/bootstrap.sh --deploy` does all of this for you, building the
credential secret **from `server/.dev.vars`** so the bucket names, the ingest
secret and the callback hosts cannot drift from the API's own configuration.
Create them by hand only if you are not using the wizard:

```bash
cd transcoding

modal secret create openvod-creds \
  R2_ACCOUNT_ID=... \
  R2_ACCESS_KEY_ID=... \
  R2_SECRET_ACCESS_KEY=... \
  R2_BUCKET_NAME=openvod-transcoded \
  TRANSCODE_INGEST_SECRET=... \
  ALLOWED_CALLBACK_HOSTS=localhost,your-api-host.example \
  ALLOWED_SOURCE_BUCKETS=openvod-raw

# Required to exist even if you skip AI (GPU function lists this secret):
modal secret create openvod-groq-creds GROQ_API_KEY=unused

modal deploy main.py
```

Copy the `transcode_video` HTTPS URL into `MODAL_WEBHOOK_URL` on the API.
`ALLOWED_CALLBACK_HOSTS` is a hostname only (no `https://`) — the host of your
`BACKEND_URL` (the API builds callbacks from it), plus `localhost` for
`wrangler dev`.

### 8. Dashboard

Local:

```bash
pnpm --filter web dev
```

Set in `web/.env` locally, in the root `.env` for Compose (they are passed as
build args), or in Vercel:

- `NEXT_PUBLIC_API_BASE_URL` — e.g. `http://localhost:8787/api`
- `NEXT_PUBLIC_AUTH_BASE_URL` — e.g. `http://localhost:8787/api/auth`
- `NEXT_PUBLIC_FRONTEND_URL` — e.g. `http://localhost:3000`

Open `/setup`. It reads `GET /health/config` (no secrets) and shows which
BYOK pieces are missing. Then create an org, mint an API key, upload a
video.

### 9. Confirm

```bash
curl http://localhost:8787/health              # ok
curl http://localhost:8787/health/config       # ready + checks
curl https://<delivery-host>/health            # delivery worker
# Modal: GET <MODAL_WEBHOOK_URL> sibling /healthz if you exposed it
./scripts/bootstrap.sh --check http://localhost:8787
```

`ready` requires database, R2, Modal URL + ingest secret, and auth/JWT.
`delivery` is advisory but you will not get playback without it. The response
also carries a `deployment` object reporting the resolved shape (runtime,
transports, providers, stores) — see
[docs/deployment-shapes.md](docs/deployment-shapes.md).

Longer notes (JWT parity, sweeper cron vs `POST /api/internal/sweep`,
Compose deployment flow): [docs/deploy.md](docs/deploy.md). Architecture axes:
[docs/deployment-shapes.md](docs/deployment-shapes.md). Playback contract:
[docs/delivery-contract.md](docs/delivery-contract.md).

## Repository layout

```
server/        Hono API — control plane (Cloudflare Worker or Node/Docker)
delivery/      Cloudflare Worker — media delivery (JWT, manifest rewriting, metering)
web/           Next.js dashboard + Developer Welcome (Vercel or Docker standalone)
sdk/           @openvod/uploader — browser upload SDK (windowed multipart, resumable)
player/        @openvod/player — Vidstack-based React player (token auto-refresh)
server-sdk/    @openvod/server — server SDK (upload/playback tokens, webhooks)
examples/      nextjs-integration — the documented upload → play → webhook flow
transcoding/   openvod_transcoder — shared engine (FFmpeg + Shaka + Whisper),
               the Modal runner, and the self-hosted agent + CLI
docs-site/     Fumadocs documentation site
docs/          Long-form markdown (deployment shapes, delivery contract, integrations)
setup/         openvod-setup — interactive bootstrap wizard (TS, clack + chalk + ora)
scripts/       bootstrap.sh launcher (toolchain + wizard exec)
```

## Development & tests

```bash
pnpm install
pnpm dev:infra                # dev Postgres (:5433) + Redis (:6379), waits for health
pnpm db:migrate               # apply migrations to the dev database
pnpm dev                      # API on Node (:8787) + web (:3000)
pnpm dev:workers              # same pair, API under wrangler dev (:8787) — needs DB_DRIVER=neon-http
pnpm dev:all                  # dev + delivery worker (:8788) + sdk/player watch builds
pnpm dev:example              # examples/nextjs-integration (:3000) — the documented flow
                              #   (run `pnpm --filter @openvod/{uploader,player,server} build` first)
pnpm dev:infra:down           # stop dev infra, keep data
pnpm dev:infra:reset          # stop dev infra and drop the dev database volume
pnpm db:up / pnpm db:down     # dev Postgres only (compatibility aliases)
pnpm start                    # built artifacts: bundled Node API (PORT, :4080) + next start
pnpm test                     # server/delivery/sdk/player/server-sdk/setup suites
pnpm --filter vod-api test
pnpm --filter ./delivery test
pnpm --filter ./sdk test
pnpm --filter ./player test
pnpm --filter ./server-sdk test
(cd transcoding && .venv/bin/python -m pytest)
```

`pnpm dev` runs the API on the **Node** runtime (`tsx watch`) and is the
default because it works with the dev Postgres out of the box. `pnpm dev:workers`
runs the same API under `wrangler dev`; it needs `DB_DRIVER=neon-http` with a
Neon URL **by design** — the Workers runtime forbids reusing a TCP socket
across requests, so a `pg` connection cannot survive past the first query.
Neither command starts a database, and the API boots without one: `GET /health`
still answers `ok` and `/health/config` still reports `database: true` (those
checks only verify the URL is configured) while real queries fail. Which
database is used is `DATABASE_URL` in `server/.dev.vars`.

`pnpm dev:infra` starts Postgres and Redis from `docker-compose.dev.yml`
(project `openvod-dev`) and waits for both health checks; that file has no API
or web service, because application code runs on the host. Rows live in the
named volume `openvod_dev_postgres` and survive `dev:infra:down`; only
`dev:infra:reset` drops them. If you ran the previous stack, a stale container
named `vod-postgres-dev` may still hold port 5433 — `docker rm -f vod-postgres-dev`.
The old dev database volume is not used by the new dev compose file.

`pnpm dev` and `docker compose up -d` both want ports 8787/3000 — run the dev
setup or the deployment stack, not both. (The dev compose file has no `api`/
`web` services, so there is nothing to stop first.) The Workers' local ports
are pinned in `server/wrangler.jsonc` (:8787) and `delivery/wrangler.jsonc`
(:8788), so a busy port fails loudly instead of drifting. Next is not pinned:
`next dev` quietly moves to :3001 when :3000 is taken (check
`FRONTEND_URL`/`CORS_ORIGINS` then), and `next start` fails outright with
`EADDRINUSE`.

`pnpm start` builds first (`pnpm start:prepare`), so re-run it after changing
`NEXT_PUBLIC_*` values — Next inlines them at build time. The dev servers need
the per-package env files from [step 4](#4-clone-and-write-env-files);
`docs-site` is not part of any aggregate command (it also defaults to :3000):
run it with `PORT=3002 pnpm --filter openvod-docs dev`.

CI runs the full suite against a Postgres service; the Redis rate-limit
adapter's integration test runs when `TEST_REDIS_URL` is set and skips cleanly
otherwise, and both compose files are validated with `docker compose config`.
The full contributor workflow (single-service commands, TDD, PR checks) is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Transcoding providers

Videos can be encoded by **Modal** or by a **self-hosted agent** on your own
machine. Both run the same processing engine (`transcoding/openvod_transcoder`),
so the ladder, packaging, validation and video lifecycle are identical — only the
execution environment differs.

| Source | Provider | Raw bucket needed? |
| --- | --- | --- |
| File on your machine | self-hosted agent | no |
| Browser / SDK upload | self-hosted agent | yes |
| Browser / SDK upload | Modal | yes |

`TRANSCODE_PROVIDER` selects the installation default (`modal` unless set);
existing installations are unaffected, and the choice is stored per job so
changing the default never reroutes work that already exists. A local-only
installation needs no raw bucket, no Modal account and no QStash —
`UPLOADS_ENABLED=false` makes upload routes return 403, which is what makes a
deployment valid without a raw bucket. Provider selection is one of the
choosable deployment axes; see
[docs/deployment-shapes.md](docs/deployment-shapes.md).

See [docs/self-hosted-transcoding.md](docs/self-hosted-transcoding.md) for
setup, hardware selection and troubleshooting, and
[docs/delivery-contract.md](docs/delivery-contract.md) for the agent protocol.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE). Documentation content in `docs-site/`
and `docs/` is [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
