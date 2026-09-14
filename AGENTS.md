# AGENTS.md - Agentic Coding Guidelines

Guidelines for agents working on the **OpenVOD** codebase (open-source BYOK
VOD platform).

## Repository layout (single pnpm workspace at the repo root)

```
server/        Hono API — control plane (Cloudflare Worker or Node/Docker)
delivery/      Cloudflare Worker — media delivery (JWT, manifest rewriting, metering)
web/           Next.js dashboard + Developer Welcome (/setup BYOK page)
sdk/           @openvod/uploader — browser upload SDK (windowed multipart,
               resumable sessions, typed errors)
player/        @openvod/player — Vidstack React player (token auto-refresh)
server-sdk/    @openvod/server — server SDK (upload/playback tokens, webhook
               signature verification); webhook verify uses WebCrypto
examples/      nextjs-integration — the documented upload → play → webhook flow,
               compiled in CI so the docs cannot drift
transcoding/   openvod_transcoder — shared processing engine (FFmpeg + Shaka +
               Whisper), the Modal runner (main.py), and the self-hosted agent
               (`openvod_transcoder.agent`: CLI, daemon, journal) + pytest
docs-site/     Fumadocs documentation site (package: openvod-docs) — the
               developer-facing docs: quickstart, framework integrations,
               API reference, error catalogue, configuration
docs/          Maintainer-facing markdown: cross-service contracts
               (delivery-contract.md), architecture rationale
               (deployment-shapes.md), operator guides (deploy.md,
               self-hosted-transcoding.md), build recipe
               (transcoding-toolchain.md) and known-gaps.md
scripts/       bootstrap.sh launcher (toolchain + wizard exec)
setup/         openvod-setup — interactive bootstrap wizard (TS, clack + chalk + ora)
```

## Commands (workspace)

```bash
pnpm install                  # root ONLY — never inside a package
pnpm dev                      # API (Node, tsx watch :8787) + web (Next :3000), parallel
pnpm dev:workers              # same pair, API under wrangler dev (:8787)
pnpm dev:all                  # adds delivery worker + sdk/player watch builds
pnpm dev:infra                # dev Postgres :5433 + Redis :6382 (docker-compose.dev.yml, waits for health)
pnpm dev:infra:down           # stop dev infra, keep data
pnpm dev:infra:reset          # stop dev infra and drop the dev Postgres volume
pnpm start                    # build:node + next build, then run both artifacts
pnpm db:up / pnpm db:down     # dev Postgres only (compatibility aliases for dev:infra)
pnpm db:migrate               # drizzle-kit migrate, reads server/.dev.vars
pnpm db:seed                  # first tenant
pnpm docker:up / :down / :build / :migrate / :logs / :reset   # deployment stack (docker-compose.yml, root .env)
# DB_DRIVER=pg is impossible on Workers — the server refuses to start with an
# explanatory message. `pnpm dev:workers` needs neon-http + a Neon URL by design;
# `pnpm dev` (Node) is the default and works with the dev Postgres.
# worker ports are pinned in wrangler.jsonc (:8787 API, :8788 delivery) — a busy
# port fails loudly; Next dev silently moves to :3001 when :3000 is taken
pnpm test                     # server/delivery/sdk/player/server-sdk/setup suites
pnpm build                    # builds packages that define build
pnpm lint                     # web (eslint) + others that define it
pnpm test:setup                # openvod-setup wizard unit tests
pnpm typecheck                # sdk/player/server-sdk typecheck scripts
pnpm typecheck:tsc            # server + delivery tsc --noEmit
(cd transcoding && .venv/bin/python -m pytest)   # python logic tests
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/vod_dev \
  pnpm --filter vod-api test                     # ...including the real-DB suites
TEST_REDIS_URL=redis://localhost:6382 pnpm --filter vod-api test   # ...and the live Redis adapter
pnpm --filter ./server test   # one package (filters match paths or names)
pnpm --filter vod-api exec tsc --noEmit
```

Per-package: `web` (Next 16 standalone: `output: "standalone"`; `dev:workers`
is just `next dev`), `sdk`/`player` (tsup + vitest), `delivery` (wrangler +
vitest pool-workers), `server` (`dev` = Node `tsx watch src/node/server.ts`,
`dev:workers` = `wrangler dev` :8787; drizzle `db:migrate` (authoritative —
`db:push` cannot create the hand-written trigger)/`db:seed`;
the Docker image runs `tsx` on `src/node/migrate.ts` then `src/node/server.ts`;
`build:node` + `start:node` remain available for a bundled Node runtime).

## Stack notes (verified)

- **Runtime:** the same Hono app runs on Node (`@hono/node-server` in
  `src/node/server.ts` — `pnpm dev`, `pnpm start`, Docker) or Cloudflare Workers
  (`pnpm dev:workers`, `wrangler deploy`). `DB_DRIVER` picks the Postgres
  transport: `pg`/postgres-js (Node only — the server refuses to start on
  Workers) vs `neon-http` (both). Composition roots live in
  `server/src/runtime/`: `deployment.ts` decides every choosable axis once and
  purely, `node.ts`/`workers.ts` wire the resulting capabilities, and an
  entrypoint hands one of them to `createApp`. Put runtime-only behavior behind
  a port there — never a runtime branch inside a route. Docs:
  `docs/deployment-shapes.md`.
- **Queue:** direct HTTP dispatch to the Modal endpoint is the default
  (`utils/queue.ts`, typed `DispatchError` on final failure, never retries
  4xx); QStash is an optional adapter (used only when `QSTASH_TOKEN` set).
- **Rate limiting:** `REDIS_URL` (plain TCP, Node only; fatal on Workers) →
  Upstash Redis REST (`UPSTASH_REDIS_REST_URL/TOKEN`, works on both runtimes) →
  in-memory sliding window (`lib/rateLimit/memory.ts`) — always on, never
  fail-open.
- **Video state machine** (`lib/videoState.ts`): pure transition rules;
  late/duplicate transcode callbacks are guarded (never resurrect `failed`,
  never downgrade `ready`). Complete handlers dispatch the job BEFORE
  `uploading→processing`.
- **Sweeper** (`utils/jobSweeper.ts` + `sweepAdapters.ts`): heartbeat-aware
  recovery of stuck `processing` (>45 min stale ⇒ retry ≤3 ⇒ typed
  `JOB_TIMEOUT`) and abandoned `uploading` rows; endpoint
  `POST /api/internal/sweep` (INTERNAL_SWEEP_SECRET), opt-in cron
  (`SWEEP_ENABLED`), retry endpoint `POST /api/video/:id/retry`, heartbeats
  `POST /api/webhook/heartbeat`.
- **Health:** `GET /health` (ok), `GET /health/config` (public capability
  flags — never secrets; consumed by landing + /setup; also carries an additive
  `deployment` object with the resolved shape — runtime, transports, providers,
  stores, `deliveryRuntime`/`deliveryUrl` — see `docs/deployment-shapes.md`),
  delivery `GET /health`, Modal `GET /healthz`.
- **Delivery worker** verifies HS256 JWTs (iss `openvod`, aud `playback`,
  shared `JWT_SECRET`) per request for signed content, rewrites every
  URI-bearing HLS/DASH tag (never foreign-host URLs), serves 206 ranges,
  meters bandwidth into Analytics Engine, cache-tags signed segments.
- **Transcoding** reports stable `error_code`s (see `docs/delivery-contract.md`),
  heartbeats non-fatally, adapts segment duration to short clips, verifies
  uploads (typed `PARTIAL_UPLOAD`), pre-bakes Whisper weights. The engine lives in
  `transcoding/openvod_transcoder` and must import without Modal/boto3/CUDA —
  `tests/test_engine_isolation.py` enforces that in a subprocess with the
  optional packages blocked. Provider selection is stored per job
  (`transcode_job.provider`); never re-derive it from the environment.
- **Self-hosted agents** authenticate with an organization-scoped token that
  cannot mint playback tokens or read another tenant's data (`requireAgent`, not
  a scope flag). They hold **no storage credentials**: transfers are presigned
  per artifact, bounded to the attempt prefix and to paths on the inventory.
  Completion is gated on a fully verified inventory and on attempt ownership, in
  one statement. `SELF_HOSTED_ENABLED=false` is the rollback — it stops new local
  submissions and cancels nothing.
- **Uploads:** windowed presigned URLs via `/v1/upload/parts` (cap 100);
  `/create` never pre-mints URLs; completes HEAD-verify size; global cap
  `MAX_UPLOAD_SIZE_BYTES` (default 25 GiB).

## Secrets/hygiene (hard rules)

- Never commit `.env*`/`.dev.vars*` except `.example` templates; never log
  Authorization headers, tokens, presigned URLs or secrets. Debug logs stay
  behind env flags (`DELIVERY_DEBUG`, `LOG_LEVEL`).
- This repo's history was rewritten to purge a leaked R2 key — treat that as
  the precedent: rotate first, then scrub, verify with git grep.
- `docs-site/` has a root gitignore allowlist (pnpm intermittently
  materializes a store farm there) — keep it in sync if you add files.

## Code style

Strict TS; `unknown` over `any`; kebab-case files, PascalCase components,
`isXxx`/`hasXxx` booleans; import order external → internal → relative;
web uses `@/*` alias. TDD at pre-agreed seams (see server/tests/README.md and
transcoding/tests/README.md): red → green vertical slices, one test per slice,
expected values from literals/worked examples (never re-derived from code).

## Common tasks

- **New API route**: file in `server/src/routes/`, register in
  `server/src/app.ts`, `c.executionCtx.waitUntil()` for background work
  (Node polyfill exists in the container entry).
- **New web component**: `web/components/...`, export from collections.
- **New delivery behavior**: extract a pure helper, export it, test it.
- **Database behaviour**: assert it in a `*.db.test.ts` suite against real
  Postgres, not with a SQL-substring assertion. Four P1 defects in the
  self-hosted review passed every substring check while being unable to execute
  (`FOR UPDATE` on a nullable outer join, nested `VALUES`) or reading a snapshot
  taken before their own writes. Set `TEST_DATABASE_URL`; suites skip cleanly
  without it. Import app modules inside the suite, never at file scope —
  `lib/database` throws without `DATABASE_URL`.
- **Env changes**: update the committed templates (`server/.dev.vars.example`,
  `delivery/.dev.vars.example`, `web/.env.example`, root `.env.example`) and
  `server/src/lib/config.ts` validation; keep `/health/config` secret-free.
  `server/.dev.vars` is now the **development-only** config (`pnpm dev`,
  `pnpm dev:workers`, migrations, tests), loaded through
  `server/src/lib/load-local-env.ts` (`.dev.vars` then `.env`, real env vars
  always win) — never add a second server-side local env file. A Docker Compose
  **deployment** is configured by the root `.env` (template `.env.example`),
  which Compose reads for both interpolation and the `api`/`maintenance`
  container environment; do not document or wire `.dev.vars` as deployment
  config.
- **Runtime axes**: choosable vs fixed behavior is decided in
  `server/src/runtime/deployment.ts`, wired in `node.ts`/`workers.ts`. Adding a
  runtime-specific capability means adding a port there — not branching on the
  runtime in a route. Fatal combinations (`DB_DRIVER=pg` or `REDIS_URL` on
  Workers, an unknown `TRANSCODE_PROVIDER`) refuse to boot by design.
- **Documentation**: two surfaces, split by audience. `docs-site/` is the
  published Fumadocs site for developers integrating and operators deploying
  (content in `docs-site/content/docs/`, groups ordered by `meta.json` at each
  level). `docs/` is maintainer-facing material that belongs next to the code —
  cross-service contracts (`delivery-contract.md`), architecture rationale
  (`deployment-shapes.md`), operator guides and build recipes.
  **`docs/known-gaps.md` is the standing record of deliberate gaps and deferred
  work** — put a new limitation there rather than writing another point-in-time
  handoff document.
  A new docs-site page must be listed in the nearest `meta.json` or it falls to
  that file's `...` catch-all, unordered — keep `...` and keep it last.
  `docs-site` is built in CI (`docs` job) and typechecked through the
  `js-workspace` matrix, so a broken page fails the build; run
  `pnpm --filter openvod-docs build` before pushing.
  **Every claim in the docs must be traceable to source** — endpoint fields from
  `server/src/routes/`, error codes from `sdk/src/errors.ts` and
  `server-sdk/src/errors.ts`, env vars from the `.example` templates. Never
  invent a code, field or variable. Framework snippets must stay consistent with
  `examples/nextjs-integration`, which is compiled on every commit; when they
  disagree, the example is right. Do not bounce readers to the README for setup
  content that belongs on the docs site. See `docs-site/README.md` for the
  authoring conventions and the MDX gotchas (`{#anchor}` is invalid MDX; the
  root `.gitignore` allowlists `docs-site/`, so a new top-level directory there
  needs an entry).

## Environment variables (key set — see `server/.dev.vars.example` for development; root `.env.example` for deployment)

`DATABASE_URL`, `DB_DRIVER`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`FRONTEND_URL`, `CORS_ORIGINS` (wildcard `*.` patterns supported),
`BACKEND_URL`, `ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`RAW_BUCKET_NAME`, `TRANSCODED_BUCKET_NAME`, `CLOUDFLARE_ANALYTICS_TOKEN`,
`MODAL_WEBHOOK_URL`, `TRANSCODE_INGEST_SECRET` (wins over the legacy alias
`MODAL_WEBHOOK_SECRET` in both directions), `QSTASH_TOKEN` (optional),
`TRANSCODE_PROVIDER` (`modal` default | `self-hosted`), `SELF_HOSTED_ENABLED`,
`UPLOADS_ENABLED` (enforced — upload routes 403 when false),
`TRANSCODE_ORG_CONCURRENCY_CAP`,
`JWT_SECRET`, `DELIVERY_URL` (single delivery base URL everywhere),
`INTERNAL_SWEEP_SECRET`, `SWEEP_*`, `MAX_UPLOAD_SIZE_BYTES`,
`REDIS_URL` (plain TCP, Node runtime only — fatal on Workers; takes precedence
over Upstash), `UPSTASH_REDIS_REST_URL/TOKEN` (optional), `RATE_LIMIT_*`.
Web: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_AUTH_BASE_URL`,
`NEXT_PUBLIC_FRONTEND_URL`.

## Dependencies

- web: Next 16 (standalone), React 19, better-auth, TanStack Query, Tailwind 4
- server: Hono, Drizzle ORM, neon-http + postgres.js, better-auth, AWS SDK S3,
  @hono/node-server, Upstash (optional)
- delivery: Hono, jose
- transcoding: Modal, FFmpeg/Shaka, faster-whisper, Groq (optional).
  The engine and the agent need only `requests`; Modal/boto3/Whisper are optional
  and imported lazily by the code path that uses them.
- agent image: `transcoding/Dockerfile.agent` (source-built FFmpeg + pinned Shaka
  + the CLI). GPU support is runtime device passthrough, not a different image.
- media toolchain: one shared recipe (`transcoding/toolchain/`) builds FFmpeg
  9.0.1 for BOTH the Modal image (`transcoding/main.py`) and the agent image;
  `versions.env` is the only place a version/hash/digest is written down, and
  both images run `verify_toolchain.sh` at build time. See
  `docs/transcoding-toolchain.md`. `OPENVOD_REQUIRE_MEDIA_TOOLS=1` (set in CI)
  turns a missing ffmpeg/packager into a test failure instead of a skip.
