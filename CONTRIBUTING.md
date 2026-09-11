# Contributing to OpenVOD

Thanks for contributing! OpenVOD is an open-source, self-hostable VOD platform:
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
sdk/            @openvod/uploader — TypeScript upload SDK
player/         @openvod/player — Vidstack-based React player
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
   `cp web/.env.example web/.env` (`./scripts/bootstrap.sh` writes the first two
   for you). `server/.dev.vars` is read by `wrangler dev`, Compose, the Node
   runtime (`pnpm start`) and drizzle-kit alike — there is no separate
   `server/.env` to keep in sync. Real values are gitignored; only the
   `*.example` templates are committed.
3. Start the local database, then a runtime:
   - `pnpm db:up` — the dev Postgres (host port 5433, `vod_dev`); rows live in
     the named volume `vod_postgres_dev_data` and survive `db:down`/recreate.
     `pnpm db:down` stops it.
   - `pnpm db:migrate` once (and after pulling new migrations) — it reads
     `DATABASE_URL` from `server/.dev.vars`, so it targets that local database.
   - `pnpm dev` — API (`wrangler dev`, port 8787) and web (Next.js, port 3000)
     in parallel, with prefixed logs. Workers semantics: pair it with
     `DB_DRIVER=neon-http` and a Neon URL.
   - `pnpm dev:node` — the same pair with the API on the **Node** runtime
     (`tsx watch`), which is the one to use with the local Postgres
     (`DB_DRIVER=pg`). `API_PORT=…` moves just the API if 8787 is taken.
   - `pnpm dev:all` — `pnpm dev` plus the delivery worker (:8788) and the
     `sdk`/`player` watch builds
   - `pnpm start` — the production artifacts instead of the dev servers:
     `build:node` + `next build`, then the bundled Node API on `PORT`
     (default 4080) and `next start`

   **Which database does each runtime use?** Whatever `DATABASE_URL` in
   `server/.dev.vars` points at — by default the `pnpm db:up` Postgres. Neither
   command starts a database, and the API will boot without one: `GET /health`
   stays `200` and `/health/config` still reports `database: true`, because
   those checks only validate that the URL is set. Only real queries fail, so
   start the database first.

   **`wrangler dev` cannot use Postgres over TCP (`DB_DRIVER=pg`).** The Workers
   runtime forbids reusing sockets across requests, so the API serves the first
   database request and then fails with `Cannot perform I/O on behalf of a
   different request`. Hence `pnpm dev:node` for local Postgres, and
   `docker compose up -d api` / `pnpm start` (also Node) as alternatives; both
   were verified with repeated queries.

   `docs-site` is deliberately not part of either aggregate command — it also
   defaults to port 3000; run it with
   `PORT=3002 pnpm --filter openvod-docs dev` (pass the port as an env var, not
   a `-p` flag: pnpm parses `-p` as its own `--parallel` shorthand).

   To run a single service in its own terminal (useful for isolating logs):
   `pnpm --filter vod-api dev`, `pnpm --filter web dev`,
   `pnpm --filter delivery dev`.

   Stop any Compose stack first (`docker compose stop api web`): the Workers'
   dev ports are pinned in each `wrangler.jsonc` (`dev.port`/`dev.inspector_port`
   — API :8787, delivery :8788), so `wrangler dev` fails hard while those ports
   are taken instead of drifting somewhere your env files don't point at. Next
   is *not* pinned: `next dev` quietly moves to :3001 when :3000 is taken (then
   `FRONTEND_URL`/`CORS_ORIGINS` no longer match), and `next start` fails with
   `EADDRINUSE` instead.
4. Modal transcoding is only exercised against your own Modal account
   (`modal deploy` in `transcoding/`) — see the docs before running it.

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
when it is unset. CI provides a Postgres service.

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
