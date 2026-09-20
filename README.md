# ClipMux

**Open-source, self-hosted video infrastructure. Bring your own keys.**

Paste your Cloudflare R2 credentials and a Modal endpoint and get Mux-style
HLS/DASH ingestion: multipart uploads, GPU transcoding, signed playback URLs,
optional AI subtitles & chapters, tenant webhooks and usage analytics — on
accounts you control.

## Why ClipMux

- **BYOK**: Cloudflare R2 for storage, Modal for GPU transcoding, your Postgres
  for metadata.
- **Mux-style DX**: upload tokens → direct-to-R2 multipart, typed transcode
  callbacks, playback JWTs with UA/domain binding.
- **Open**: Apache-2.0. Optional integrations (QStash, Upstash Redis, Workers
  Analytics Engine) have a fallback or a documented no-op.

## Run it or develop it

| I want to… | Start here |
| --- | --- |
| **Read the docs** — setup, integration guides, API reference | [docs site](docs-site) — `pnpm --filter clipmux-docs dev`, or the built site |
| **Run ClipMux** on a machine or VPS | [`scripts/install.sh`](#host-install) below, then [docs-site host install](docs-site/content/docs/host-install.mdx) |
| **Integrate it into my app** (Next.js, Vite, Nuxt, SvelteKit, Node) | [docs-site/content/docs/integrations](docs-site/content/docs/integrations) |
| **See what differs per install** (API runtime, Postgres transport, transcoder, rate-limit store) | [docs/deployment-shapes.md](docs/deployment-shapes.md) |
| **Develop ClipMux** — change the code | [CONTRIBUTING.md](CONTRIBUTING.md) |

The `docs-site/` Fumadocs app is the developer-facing reference: quickstart,
framework integration guides, the full `/v1` API reference, an error-code
catalogue and the configuration reference. This README remains the shortest path
to a running installation; the docs site is where the detail lives.

**Fastest path to a running installation on this machine or a VPS:**

```bash
curl -fsSL https://raw.githubusercontent.com/visheshgubrani/vod/main/scripts/install.sh | bash
```

That installer provisions Docker Compose, writes `.env`, starts the app behind
Caddy, and walks self-hosted encoder pairing. Cloudflare is still required.
Details: [Install on a host](docs-site/content/docs/host-install.mdx).

**Contributor setup** (Node on the host, not the operator installer):
`./scripts/bootstrap.sh` — installs Node + pnpm when missing (nvm first, then
the distro package), installs workspace deps, and runs an interactive wizard
in three phases: **choices** (Postgres, transcoder, queue, rate-limit store,
AI), **requirements** (what those choices need on this machine, with
permission-aware installs), then **credentials**. It writes one
*configuration target* per run — `dev` (`server/.dev.vars` +
`delivery/.dev.vars`) or `deploy` (the root `.env` for Docker Compose). Re-run
with `--deploy` when you are ready: Cloudflare + Modal logins, R2 buckets/CORS,
worker + GPU pipeline deploys and secret uploads; a deployment that does not
finish exits nonzero and lists what is left. You still paste an **R2 S3 API
token** (Wrangler cannot mint those) and a **Postgres URI** unless the stack
runs its own Postgres.

`./scripts/bootstrap.sh --doctor` reports what this machine has and what the
current configuration needs — read-only, no installs, safe on someone else's
machine. Read-only and headless modes (`--doctor`, `--check`, `--answers`, and
any run without a TTY) install nothing at all; an interactive run installs
user-scoped toolchain pieces and system packages only with root or passwordless
sudo (never by prompting for a password — it prints the command instead).

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
| [Cloudflare](https://dash.cloudflare.com/sign-up) account | R2 buckets and the **delivery** Worker | Free tier is enough to start |
| Two **R2** buckets | Raw uploads vs transcoded HLS/DASH | R2 → Create bucket |
| An **R2 API token** (S3 credentials) | API, Modal, and uploads talk to R2 over the S3 API | R2 → Manage R2 API Tokens |
| Cloudflare login | Deploy the delivery worker | wrangler is a pinned local devDependency of `delivery/` — `cd delivery && pnpm exec wrangler login`, never a global `npx wrangler` |
| [Postgres](https://www.postgresql.org) **or** Docker | Metadata, auth, video rows | Any `postgresql://` URL (Neon is ordinary hosted Postgres), or the `postgres` service inside the Compose stack |
| [Modal](https://modal.com) account (only for the Modal transcoder) | GPU transcoding (FFmpeg / Shaka / Whisper) | `--deploy` prepares `transcoding/.venv` (uv, else `python3 -m venv`) and runs `modal setup` — or `modal token set` when a browser login is not possible |
| Docker (Compose v2) | The Compose stack, the dev Postgres/Redis, and the self-hosted transcoder agent | `./scripts/bootstrap.sh --doctor` checks the daemon, not just the binary; Docker is installed by Docker's own instructions, never with a guessed package name |
| Node 22 + pnpm 12 | Workspace install / `wrangler` / dashboard | `./scripts/bootstrap.sh` installs both when missing (nvm first, then the distro package, re-checking the version) |

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
  `MODAL_WEBHOOK_URL`, `TRANSCODE_INGEST_SECRET`, `JWT_SECRET`,
  `BETTER_AUTH_SECRET`, `DELIVERY_URL` and the three public origins.
- [Keys you will collect → Optional](docs-site/content/docs/quickstart.mdx) —
  `GROQ_API_KEY`, `CLOUDFLARE_ANALYTICS_TOKEN`, OAuth, `QSTASH_TOKEN`,
  `REDIS_URL`, Upstash.

[`server/.dev.vars.example`](server/.dev.vars.example) and
[`.env.example`](.env.example) remain the authoritative, commented templates —
they are what the wizard and Compose actually read. The full environment
reference is
[docs-site/content/docs/configuration.mdx](docs-site/content/docs/configuration.mdx).

One capability behaves differently enough to say here: `CLOUDFLARE_ANALYTICS_TOKEN`
is **read** access. Playback telemetry is **written** through the Analytics Engine
binding, which exists on Cloudflare Workers only, so a Node API (`pnpm dev`, or
the Compose deployment) reads analytics and records none — the dashboard says so
rather than showing a zero. See
[docs/deployment-shapes.md](docs/deployment-shapes.md#analytics-has-two-independent-halves).

---

## Host install

Operator path for a machine or VPS. Contributor bootstrap stays separate.

```bash
curl -fsSL https://raw.githubusercontent.com/visheshgubrani/vod/main/scripts/install.sh | bash
./scripts/install.sh --doctor     # read-only
./scripts/install.sh              # from a checkout: uses that tree unless CLIPMUX_DIR is set
```

Pin both the URL and the variable to the same ref — the script does not infer
one from the other:

```bash
CLIPMUX_VERSION=<git-sha> curl -fsSL \
  https://raw.githubusercontent.com/visheshgubrani/vod/<git-sha>/scripts/install.sh | bash
```

Defaults: `/opt/clipmux` as root, `~/clipmux` otherwise. Access is
`http://localhost` or a public HTTPS hostname. Localhost encoding is
self-hosted; Modal needs a reachable HTTPS API. Resume with the same command
(config, secrets and volumes are kept). Stop without deleting data:
`docker compose down`. There is no `--update` in v1.

Full operator notes: [docs-site host install](docs-site/content/docs/host-install.mdx).

---

## Setup

There are two configurations, and **one run owns exactly one of them**:

| Target | Files | For |
| --- | --- | --- |
| `dev` (default) | `server/.dev.vars` + `delivery/.dev.vars` | running the API here (`pnpm dev`), or deploying it as a Cloudflare Worker |
| `deploy` | the root `.env` | the Docker Compose stack on a server |

When both exist the wizard asks which one this run owns; headless runs must say
(`--target`). Secrets (`JWT_SECRET`, `BETTER_AUTH_SECRET`, …) are **reused** from
the target file when it already has them — regenerating them would invalidate
playback tokens and lock you out of a database whose volume still holds the old
password. `--rotate-secrets` replaces them deliberately.

The wizard runs in phases: **choices** (how the installation is shaped),
**requirements** (what the machine needs for those choices, with an offer to
install what it is allowed to), **credentials** (only what the choices require),
then the opt-in **deploy**.

```bash
./scripts/bootstrap.sh                     # interactive configure
./scripts/bootstrap.sh --target deploy     # configure the Compose stack instead
./scripts/bootstrap.sh --doctor            # report only: installs nothing
./scripts/bootstrap.sh --force             # regenerate; unmanaged keys + secrets preserved
./scripts/bootstrap.sh --answers env.json  # headless configure (see --help)
./scripts/bootstrap.sh --deploy            # provision & deploy: CF + Modal logins,
                                           # R2 buckets/CORS, pipeline + worker deploys
./scripts/bootstrap.sh --check [api-url]   # verify the config without printing secrets
```

Choices the wizard asks about: **Postgres** (the bundled/dev container, or your
own URL — a Neon connection string is a regular `postgresql://` URL),
**analytics** (on by default), the **transcoder** (**Modal**, GPU in the cloud, or
**this machine**, the self-hosted Docker agent), browser **uploads** (a local-only
installation needs no raw bucket), **QStash** queueing (Modal only — self-hosted
work is queued in the database), a **rate-limit store** (in-memory, Upstash, or
your own Redis) and **AI subtitles/chapters** (Modal only — the agent
image does not ship Whisper or the Groq client yet, see
[docs/known-gaps.md](docs/known-gaps.md)). The API always runs on Node.

You will paste two things from dashboards (the CLIs cannot create them):

1. **R2 S3 API token** — [Manage API Tokens](https://dash.cloudflare.com/?to=/:account/r2/api-tokens), Object Read & Write on both buckets.
2. **DATABASE_URL** — any `postgresql://` URL (skip if you chose the bundled/dev Postgres).

Then open `/setup` on the dashboard. The rest of this section is the same
flow if you prefer to do it by hand.

### 1. Create two R2 buckets

In [Cloudflare dashboard → R2](https://dash.cloudflare.com/?to=/:account/r2):

1. Create a **raw** bucket (uploads). Example name: `clipmux-raw`.
2. Create a **transcoded** bucket (playback output). Example name: `clipmux-transcoded`.

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

- **Existing Postgres:** create a project (Neon, RDS, the machine’s Postgres,
  or any host that accepts `postgresql://…`). Copy `DATABASE_URL`.
- **Compose deployment / bundled Postgres:** skip this — the stack runs its
  own Postgres, and `DATABASE_URL` may be left blank in `.env`.

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

Those are **local development** files — `pnpm dev`,
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
  { "binding": "TRANSCODED_BUCKET", "bucket_name": "clipmux-transcoded" }
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

**Path A — Node API + Cloudflare delivery**

```bash
cd delivery
pnpm exec wrangler deploy    # uses .dev.vars locally; for production:
# pnpm exec wrangler secret bulk <secrets.json>   # ./scripts/bootstrap.sh --deploy does this for you
```

After deploy, set `DELIVERY_URL`. The API runs with `pnpm dev` or Compose.

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

modal secret create clipmux-creds \
  R2_ACCOUNT_ID=... \
  R2_ACCESS_KEY_ID=... \
  R2_SECRET_ACCESS_KEY=... \
  R2_BUCKET_NAME=clipmux-transcoded \
  TRANSCODE_INGEST_SECRET=... \
  ALLOWED_CALLBACK_HOSTS=localhost,your-api-host.example \
  ALLOWED_SOURCE_BUCKETS=clipmux-raw

# Required to exist even if you skip AI (GPU function lists this secret):
modal secret create clipmux-groq-creds GROQ_API_KEY=unused

modal deploy main.py
```

Copy the `transcode_video` HTTPS URL into `MODAL_WEBHOOK_URL` on the API.
`ALLOWED_CALLBACK_HOSTS` is a hostname only (no `https://`) — the host of your
`BACKEND_URL` (the API builds callbacks from it), plus `localhost` for
`pnpm dev`.

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
sdk/           @clipmux/uploader — browser upload SDK (windowed multipart, resumable)
player/        @clipmux/player — Vidstack-based React player (token auto-refresh)
server-sdk/    @clipmux/server — server SDK (upload/playback tokens, webhooks)
examples/      nextjs-integration — the documented upload → play → webhook flow
transcoding/   clipmux_transcoder — shared engine (FFmpeg + Shaka + Whisper),
               the Modal runner, and the self-hosted agent + CLI
docs-site/     Fumadocs documentation site
docs/          Long-form markdown (deployment shapes, delivery contract, integrations)
setup/         clipmux-setup — interactive bootstrap wizard (TS, clack + chalk + ora)
scripts/       bootstrap.sh launcher (toolchain + wizard exec)
```

## Development & tests

```bash
pnpm install
pnpm dev:infra                # dev Postgres (:5433) + Redis (:6382), waits for health
pnpm db:migrate               # apply migrations to the dev database
pnpm dev                      # API on Node (:8787) + web (:3000)
pnpm dev:all                  # dev + delivery worker (:8788) + sdk/player watch builds
pnpm dev:example              # examples/nextjs-integration (:3000) — the documented flow
                              #   (run `pnpm --filter @clipmux/{uploader,player,server} build` first)
pnpm dev:infra:down           # stop dev infra, keep data
pnpm dev:infra:reset          # stop dev infra and drop the dev database volume
pnpm db:up / pnpm db:down     # dev Postgres only (compatibility aliases)
pnpm start                    # built artifacts: bundled Node API (PORT, :4080) + next start
pnpm test                     # packages + scripts (node --test)
pnpm test:scripts             # scripts/ only: the dev runner's stale-build preflight
pnpm --filter vod-api test
pnpm --filter ./delivery test
pnpm --filter ./sdk test
pnpm --filter ./player test
pnpm --filter ./server-sdk test
(cd transcoding && .venv/bin/python -m pytest)
```

`pnpm dev` runs the API on Node (`tsx watch`) against the dev Postgres.

Neither command starts a database, and the API boots without one: `GET /health`
still answers `ok` and `/health/config` still reports `database: true` (those
checks only verify the URL is configured) while real queries fail. Which
database is used is `DATABASE_URL` in `server/.dev.vars`.

`pnpm dev:infra` starts Postgres and Redis from `docker-compose.dev.yml`
(project `clipmux-dev`) and waits for both health checks; that file has no API
or web service, because application code runs on the host. Rows live in the
named volume `clipmux_dev_postgres` and survive `dev:infra:down`; only
`dev:infra:reset` drops them. The old dev database volume is not used by the new
dev compose file.

**Port 5433 must be free.** The dev Postgres publishes `5433:5432` on the host,
so another project's Postgres already bound to 5433 is the most common failure
here — and it is a quiet one: Docker creates `clipmux-dev-postgres`, cannot
programme the port mapping, and leaves the container *created but unattached*.
The container's own health check still passes, so `up -d --wait` can exit `0`
and report `Healthy` while nothing of ours listens on 5433. `DATABASE_URL` then
reaches the other server, and the API fails with
`database "vod_dev" does not exist` (`3D000`) on its first query. Find and stop
the holder, then recreate ours so the port binds:

```bash
docker ps --filter publish=5433        # names the container holding the port
docker compose -f docker-compose.dev.yml rm -sf postgres && pnpm dev:infra
pnpm db:migrate
```

`./scripts/bootstrap.sh --check --target dev` reports this case by name, and an
interactive `./scripts/bootstrap.sh --target dev` run offers to start the dev
containers and apply migrations itself. (The previous stack's container was
named `vod-postgres-dev`; `docker rm -f vod-postgres-dev` if one is still
around.)

`pnpm dev` and `docker compose up -d` both want ports 8787/3000 — run the dev
setup or the deployment stack, not both. (The dev compose file has no `api`/
`web` services, so there is nothing to stop first.) The delivery worker's local
port is pinned in `delivery/wrangler.jsonc` (:8788), so a busy port fails loudly
instead of drifting. Next is not pinned:
`next dev` quietly moves to :3001 when :3000 is taken (check
`FRONTEND_URL`/`CORS_ORIGINS` then), and `next start` fails outright with
`EADDRINUSE`.

**Workspace packages are built before the dashboard starts.** `web` imports
`@clipmux/uploader` and `@clipmux/player` from their `dist/`, which is
gitignored — so a clone, a branch switch, or a rename inside `sdk/` leaves a
stale build behind, and the symptom is a Next compile error in the browser
("Export ClipMuxUploader doesn't exist in target module") that reads like a
source bug. `node scripts/dev.mjs` checks every package's `src/` against its
`dist/` and rebuilds the stale ones before starting anything; if a build fails
it stops with the failing filter named. `pnpm dev:all` additionally watches
`sdk`/`player`, and `pnpm dev:example` needs
`pnpm --filter @clipmux/{uploader,player,server} build` because it is not part
of that preflight.

`pnpm start` builds first (`pnpm start:prepare`), so re-run it after changing
`NEXT_PUBLIC_*` values — Next inlines them at build time. The dev servers need
the per-package env files from [step 4](#4-clone-and-write-env-files);
`docs-site` is not part of any aggregate command (it also defaults to :3000):
run it with `PORT=3002 pnpm --filter clipmux-docs dev`.

CI runs the full suite against a Postgres service; the Redis rate-limit
adapter's integration test runs when `TEST_REDIS_URL` is set and skips cleanly
otherwise, and both compose files are validated with `docker compose config`.
The full contributor workflow (single-service commands, TDD, PR checks) is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Transcoding providers

Videos can be encoded by **Modal** or by a **self-hosted agent** on your own
machine. Both run the same processing engine (`transcoding/clipmux_transcoder`),
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
