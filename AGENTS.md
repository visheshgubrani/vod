# AGENTS.md - Agentic Coding Guidelines

Guidelines for agents working on the **OpenVOD** codebase (open-source BYOK
VOD platform).

## Repository layout (single pnpm workspace at the repo root)

```
server/        Hono API — control plane (Cloudflare Worker or Node/Docker)
delivery/      Cloudflare Worker — media delivery (JWT, manifest rewriting, metering)
web/           Next.js dashboard + Developer Welcome (/setup BYOK page)
sdk/           @openvod/uploader — TS upload SDK (windowed multipart)
player/        @openvod/player — Vidstack React player (token auto-refresh)
transcoding/   Modal Python GPU pipeline (FFmpeg + Shaka + Whisper) + pytest
docs-site/     Fumadocs documentation site (package: openvod-docs)
docs/          Long-form markdown (delivery contract, security model)
scripts/       bootstrap.sh launcher (toolchain + wizard exec) + verify-env.sh
setup/         openvod-setup — interactive bootstrap wizard (TS, clack TUI)
```

## Commands (workspace)

```bash
pnpm install                  # root ONLY — never inside a package
pnpm test                     # server/delivery/sdk/player suites
pnpm build                    # builds packages that define build
pnpm lint                     # web (eslint) + others that define it
pnpm test:setup                # openvod-setup wizard unit tests
pnpm typecheck                # sdk/player typecheck scripts
pnpm typecheck:tsc            # server + delivery tsc --noEmit
(cd transcoding && .venv/bin/python -m pytest)   # python logic tests
pnpm --filter ./server test   # one package (filters match paths or names)
pnpm --filter vod-api exec tsc --noEmit
```

Per-package: `web` (Next 16 standalone: `output: "standalone"`), `sdk`/`player`
(tsup + vitest), `delivery` (wrangler + vitest pool-workers),
`server` (wrangler dev :8787; drizzle `db:migrate` (authoritative — `db:push` cannot create the hand-written trigger)/`db:seed`;
the Docker image runs `tsx` on `src/node/migrate.ts` then `src/node/server.ts`;
`build:node` + `start:node` remain available for a bundled Node runtime).

## Stack notes (verified)

- **Runtime:** API runs on Cloudflare Workers (default) or Node
  (`@hono/node-server` in `src/node/server.ts`); `DB_DRIVER` selects the
  driver: `neon-http` (Workers) vs `pg`/postgres-js (Docker/VPS).
- **Queue:** direct HTTP dispatch to the Modal endpoint is the default
  (`utils/queue.ts`, typed `DispatchError` on final failure, never retries
  4xx); QStash is an optional adapter (used only when `QSTASH_TOKEN` set).
- **Rate limiting:** Upstash Redis when configured; otherwise an in-memory
  sliding window (`lib/rateLimit/memory.ts`) — always on, never fail-open.
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
  flags — never secrets; consumed by landing + /setup), delivery
  `GET /health`, Modal `GET /healthz`.
- **Delivery worker** verifies HS256 JWTs (iss `openvod`, aud `playback`,
  shared `JWT_SECRET`) per request for signed content, rewrites every
  URI-bearing HLS/DASH tag (never foreign-host URLs), serves 206 ranges,
  meters bandwidth into Analytics Engine, cache-tags signed segments.
- **Transcoding** reports stable `error_code`s (see `docs/delivery-contract.md`),
  heartbeats non-fatally, adapts segment duration to short clips, verifies
  uploads (typed `PARTIAL_UPLOAD`), pre-bakes Whisper weights.
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
- **Env changes**: update `server/.dev.vars.example`, `.env.example`, and
  `server/src/lib/config.ts` validation; keep `/health/config` secret-free.

## Environment variables (key set — see .dev.vars.example for the full list)

`DATABASE_URL`, `DB_DRIVER`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`FRONTEND_URL`, `CORS_ORIGINS` (wildcard `*.` patterns supported),
`BACKEND_URL`, `ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`RAW_BUCKET_NAME`, `TRANSCODED_BUCKET_NAME`, `CLOUDFLARE_ANALYTICS_TOKEN`,
`MODAL_WEBHOOK_URL`, `TRANSCODE_INGEST_SECRET`, `QSTASH_TOKEN` (optional),
`JWT_SECRET`, `DELIVERY_URL`, `INTERNAL_SWEEP_SECRET`, `SWEEP_*`,
`MAX_UPLOAD_SIZE_BYTES`, `UPSTASH_REDIS_REST_URL/TOKEN` (optional),
`RATE_LIMIT_*`. Web: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_AUTH_BASE_URL`,
`NEXT_PUBLIC_FRONTEND_URL`.

## Dependencies

- web: Next 16 (standalone), React 19, better-auth, TanStack Query, Tailwind 4
- server: Hono, Drizzle ORM, neon-http + postgres.js, better-auth, AWS SDK S3,
  @hono/node-server, Upstash (optional)
- delivery: Hono, jose
- transcoding: Modal, FFmpeg/Shaka, faster-whisper, Groq (optional)
