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
transcoding/    Modal Python GPU pipeline (FFmpeg + Shaka + Whisper)
clipmux-docs/   Fumadocs documentation site
docs/           Long-form markdown (integration guides, contracts, branding)
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
2. Per-package local configuration lives in `.dev.vars` (server/delivery) or
   `.env` — copy the `.example`/`.env.example` file in each package first.
3. Run services in separate terminals:
   - `pnpm --filter server dev` (wrangler dev, port 8787)
   - `pnpm --filter web dev` (Next.js, port 3000)
   - `docker compose up -d postgres` for the local dev database
   - `pnpm --filter delivery dev` for the delivery worker
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
pnpm --filter server test        # vitest (unit + integration w/ TEST_DATABASE_URL)
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
   build smoke, and the branding grep gate (no `clipmux`/`indiemux` strings in
   source).
5. Two approvals are not required — maintainers review and merge.

## Reporting bugs & security issues

Bugs go to [GitHub Issues](https://github.com/visheshgubrani/vod/issues) using
the templates. **Security vulnerabilities must not be filed as public issues** —
see [SECURITY.md](./SECURITY.md).
