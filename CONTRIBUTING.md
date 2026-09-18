# Contributing to ClipMux

Thanks for contributing! ClipMux is an open-source, self-hostable VOD platform:
bring your own Cloudflare R2 + Modal keys and get Mux-style HLS/DASH video
infrastructure.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating you agree to uphold it. Report unacceptable behavior to the
maintainers (see the CoC for contact details).

## Repository layout

```
server/         Hono API (Cloudflare Worker or Node/Docker) — control plane
delivery/       Cloudflare Worker — media delivery (JWT, manifest rewrite, metering)
web/            Next.js dashboard + Developer Welcome (standalone build; Vercel or Docker)
sdk/            @clipmux/uploader — browser upload SDK
player/         @clipmux/player — Vidstack-based React player
server-sdk/     @clipmux/server — server SDK (tokens, videos, webhooks)
examples/       nextjs-integration — runnable end-to-end integration example
transcoding/   Modal Python GPU pipeline (FFmpeg + Shaka + Whisper)
docs-site/     Fumadocs documentation site
docs/          Long-form markdown (integration guides, contracts)
```

The repo is a single [pnpm workspace](https://pnpm.io/workspaces) rooted at
`pnpm-workspace.yaml`. All root commands operate across packages:

```bash
pnpm install          # install the whole workspace
pnpm build            # build every package that has a build script
pnpm test             # run every package test suite
pnpm lint             # lint every package
pnpm typecheck        # type-check every package
```

## Development setup

1. `pnpm install` at the repo root.

2. Local configuration is one file per service, each with a committed template:
   `cp server/.dev.vars.example server/.dev.vars`,
   `cp delivery/.dev.vars.example delivery/.dev.vars` and
   `cp web/.env.example web/.env` (`./scripts/bootstrap.sh --target dev` writes the first two
   for you). `server/.dev.vars` is **development-only**: `pnpm dev`,
   migrations, the seed script and the drizzle CLI load it
   through `server/src/lib/load-local-env.ts`, and real env vars always win. A
   *deployment* is configured by `.env` at the repo root (template:
   `.env.example`) — never by `server/.dev.vars`. Real values are gitignored;
   only the `*.example` templates are committed.

3. Start the local infrastructure, then a runtime:
   - `pnpm dev:infra` — dev Postgres (host port **5433**, database `vod_dev`)
     and Redis (host port **6382**) from `docker-compose.dev.yml` (project
     `clipmux-dev`), waiting for both health checks. `pnpm dev:infra:down`
     stops them and keeps the data; `pnpm dev:infra:reset` also drops the
     Postgres volume (`clipmux_dev_postgres`). `pnpm db:up` / `pnpm db:down`
     are kept as Postgres-only compatibility aliases. Port 5433 must be free: if
     another project's Postgres already holds it, Docker creates
     `clipmux-dev-postgres` without a network endpoint, the container still
     reports `Healthy`, `up --wait` can still exit `0`, and `DATABASE_URL`
     silently reaches the *other* server — which is where
     `database "vod_dev" does not exist` comes from. Identify the holder with
     `docker ps --filter publish=5433`, stop it, then
     `docker compose -f docker-compose.dev.yml rm -sf postgres && pnpm dev:infra`.
     (The previous stack's container was named `vod-postgres-dev`.) An
     interactive `./scripts/bootstrap.sh --target dev` offers to start this
     infra and migrate for you, and `--check --target dev` names a blocked port.
   - `pnpm db:migrate` once (and after pulling new migrations) — it reads
     `DATABASE_URL` from `server/.dev.vars`, so it targets that local database.
   - `pnpm dev` — API on the **Node** runtime (`tsx watch`, port 8787) and web
     (Next.js, port 3000) in parallel, with prefixed logs. This is the default
     because it works with the dev Postgres out of the box. `API_PORT=…` moves
     just the API if 8787 is taken. The runner first rebuilds any workspace
     package whose `dist/` is older than its `src/` (the dashboard imports
     `@clipmux/uploader`/`@clipmux/player` from `dist/`, which is gitignored),
     and stops with the failing filter named if a build breaks — otherwise a
     stale build surfaces as a Next compile error in the browser.
   - `pnpm dev:all` — `pnpm dev` plus the delivery worker (:8788) and the
     `sdk`/`player` watch builds
   - `pnpm start` — the production artifacts instead of the dev servers:
     `build:node` + `next build`, then the bundled Node API on `PORT`
     (default 4080) and `next start`

   **Which database does each runtime use?** Whatever `DATABASE_URL` in
   `server/.dev.vars` points at — by default the `pnpm dev:infra` Postgres.
   Neither command starts a database, and the API will boot without one:
   `GET /health` stays `200` and `/health/config` still reports
   `database: true`, because those checks only validate that the URL is set.
   Only real queries fail, so start the database first.

   `docs-site` is deliberately not part of either aggregate command — it also
   defaults to port 3000; run it with
   `PORT=3002 pnpm --filter clipmux-docs dev` (pass the port as an env var, not
   a `-p` flag: pnpm parses `-p` as its own `--parallel` shorthand).

   To run a single service in its own terminal (useful for isolating logs):
   `pnpm --filter vod-api dev`, `pnpm --filter web dev`,
   `pnpm --filter delivery dev`.

   `pnpm dev` and the deployment stack both want ports 8787/3000 — run one or
   the other, not both. The dev compose file has no `api`/`web` services, so
   there is nothing to stop first. The delivery worker's local ports are pinned
   in `delivery/wrangler.jsonc` (`dev.port`/`dev.inspector_port` — :8788 / 9230),
   so `wrangler dev` fails hard while those ports are taken instead of drifting
   somewhere your env files don't point at. Next
   is *not* pinned: `next dev` quietly moves to :3001 when :3000 is taken (then
   `FRONTEND_URL`/`CORS_ORIGINS` no longer match), and `next start` fails with
    `EADDRINUSE` instead.

    Ctrl-C stops the whole stack: `pnpm dev` runs under `scripts/dev.mjs`,
    which forwards SIGINT/SIGTERM to the full service tree (plain
    `pnpm --parallel` leaves `tsx watch` / `next dev` orphaned holding
    8787/3000). If ports still look taken after an old run, free them with
    `pnpm dev:cleanup` (kills stale dev processes, clears a stale
    `web/.next/dev/lock`, then reports which of 8787/8788/3000 is still
    answering) and run `pnpm dev` again.
4. Modal transcoding is only exercised against your own Modal account
   (`modal deploy` in `transcoding/`) — see the docs before running it.

   Receiving real Modal callbacks locally needs a public URL for the API:
   Modal POSTs job results to `${BACKEND_URL}/api/webhook/transcode-complete`,
   and `localhost:8787` is unreachable from Modal's cloud — without this,
   videos strand in `processing` and the DB status never flips to
   `ready`/`failed`. Public ingress is deliberately not part of
   `docker-compose.dev.yml`, because the right tool depends on the machine; any
   tunnel you can run yourself works. With ngrok:
   1. `ngrok http 8787` (the free tier is enough) and copy the `https://…`
       forwarding URL it prints. Reserved domains keep the same URL across
       restarts; a random one changes, and a stale `BACKEND_URL` fails silently.
   2. Set `BACKEND_URL=https://<your-tunnel-host>` in `server/.dev.vars` and
       restart `pnpm dev` so new dispatches carry the public callback URL.
       With the Modal provider, `pnpm dev` also reports a `BACKEND_URL` advisory
       from `GET /health/config` when it is unset or still points at localhost —
       a callback URL only this machine can reach never arrives.
   3. Allow that host on the transcoder, or the callback is blocked before it is
       ever sent: set `ALLOWED_CALLBACK_HOSTS=<your-tunnel-host>` (hostname
       only, no scheme) on the `clipmux-creds` Modal secret the transcoder
       deploys with, then redeploy if the secret is read at container start.
       `./scripts/bootstrap.sh --deploy --target dev` derives that allowlist from
       `BACKEND_URL`, so setting `BACKEND_URL` before deploying does this for
       you.
   4. Check the URL answers before uploading anything:
      `curl -s -o /dev/null -w '%{http_code}\n' https://<your-tunnel-host>/health`
      must print `200`. A `404`/`502` from ngrok's own edge means the tunnel is
      not forwarding to `:8787`; `530`/error 1033 is a Cloudflare tunnel that is
      not connected.
   5. Upload a video and watch the row go `uploading → processing → ready`.
      Webhook auth (`TRANSCODE_INGEST_SECRET`) still applies over the tunnel —
      it carries the same authenticated callbacks, it does not bypass them.
      Stop the tunnel when done testing: it exposes the local API to the
      internet while it runs.

## Development workflow (TDD)

We develop **test-first**. The testing seams are pre-agreed; tests verify
behavior at public module interfaces, never internals. See the testing section
of the docs for the full seam table.

1. **Red** — write one failing test for the behavior slice you're about to add.
2. **Green** — implement the minimum to pass it.
3. Repeat in vertical slices (one seam, one test, one minimal implementation).
4. Refactoring happens in review, not mid-loop.

Test suites per package:

```bash
pnpm --filter vod-api test       # vitest (unit + integration w/ TEST_DATABASE_URL)
pnpm --filter delivery test      # vitest + @cloudflare/vitest-pool-workers
pnpm --filter sdk test           # vitest
pnpm --filter player test        # vitest
(cd transcoding && python -m pytest tests)   # python logic unit tests
```

Integration tests that need Postgres read `TEST_DATABASE_URL` and skip cleanly
when it is unset. CI provides a Postgres service. The Redis rate-limit
adapter's live integration test reads `TEST_REDIS_URL` the same way (CI
provides a `redis:7-alpine` service); unset, it skips and the adapter's unit
tests still run. CI also validates both compose files with
`docker compose config`.

## Deploying

Development and deployment are deliberately separate stacks:
`docker-compose.dev.yml` starts Postgres + Redis only, while the end-user
deployment is `docker-compose.yml` configured by `.env` at the repo root (copy
`.env.example`). See [docs/deploy.md](docs/deploy.md) for the Compose flow and
[docs/deployment-shapes.md](docs/deployment-shapes.md) for the architecture
axes.

## Commit conventions

- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`,
  `test:`, `perf:`.
- One logical change per commit; keep history readable — this repo has had its
  history rewritten to purge a leaked secret file, so never commit `.env`/
  `.dev.vars` files or regenerable artifacts (see SECURITY.md).
- Sign-offs or CLAs are not required; contributing implies licensing your work
  under the project's Apache-2.0 license.

## Pull request process

1. Branch from `main`, prefix with `fix/`, `feat/`, `chore/`, `docs/`.
2. Add or update tests for every behavior change (red → green).
3. Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and fix failures.
4. Open the PR. CI must pass: lint/typecheck/tests, package builds, Docker
   build smoke, and the branding grep gate (legacy product names must not
   appear in source).
5. Two approvals are not required — maintainers review and merge.

## Reporting bugs & security issues

Bugs go to [GitHub Issues](https://github.com/visheshgubrani/vod/issues) using
the templates. **Security vulnerabilities must not be filed as public issues** —
see [SECURITY.md](./SECURITY.md).
