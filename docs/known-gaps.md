# Known gaps and deferred work

Standing record of what ClipMux deliberately does **not** do yet, and what is
known to be weaker than it looks. This is maintainer-facing: the docs site
(`docs-site/`) describes what the platform does, and this file describes where it
stops.

It replaced `handoff.md`, which documented a specific migration (`156f76e`,
`402f372`) that has since landed. The migration procedure is gone; the gaps it
recorded are still open and are kept here.

Anything here that becomes false should be deleted rather than annotated — this
file is only useful if it is current.

## Weak guarantees worth knowing about

- **Reclaiming a soft-deleted video's bytes does not revoke playback.** The
  delivery worker never reads the database — it verifies the JWT and reads R2
  metadata — so existing signed URLs keep working until the bytes are gone.
  `deleted` means "removed from the library", not "access revoked". Revocation
  needs a delivery-side check and is not implemented.
- **Soft-deleted videos still count toward `GET /api/usage` storage** until
  reclaimed. Arguably correct (you are still paying for them) but worth stating.
- **Eleven non-lifecycle webhook events still dispatch directly**
  (`video.uploaded`, `subtitle.*`, `chapters.*`, `video.deleted`). They get no
  retries, and their preceding state change is **not** atomic with event
  creation — a strictly weaker guarantee than `video.ready`/`video.failed`.
  Converting `dispatchWebhook` to enqueue would add retries but would not make
  those changes atomic.
- **Modal dedupe is not airtight.** `modal.Dict` is not an atomic
  compare-and-set, and the endpoint proceeds (loudly) if the store is
  unreachable, because failing closed would stop all transcoding on a Dict
  outage. The API-side claim is the primary guard; the Dict is defence in depth.
- **No hard spending limit.** Concurrency is bounded; the total bill is not.
- **`tonemap_cuda` is probably unavailable** in the Modal image (apt ffmpeg,
  which needs NPP for that filter), so HDR sources likely fail. Pre-existing.
- **`transcoding/` has unpinned pip dependencies** and no lockfile.

## Test coverage gaps

- **No route-level tests for the delivery-log/replay endpoints** or for the
  callback → outbox → delivery path under the *full* app. The full app needs
  better-auth sessions to mount; the composition suite mounts the webhook router
  directly instead. Everything underneath is covered.
- **The per-run test-database suffix is not covered by a test.** It prevents two
  concurrent runs from dropping each other's fixtures, but the race is
  timing-dependent and forcing a shared name in two parallel runs did not
  reproduce a failure. The fix removes a structural hazard; it is not
  empirically demonstrated.
- **No React 18 matrix in CI**, despite `@clipmux/player` declaring a `>=18` peer
  range. CI exercises React 19 only.
- **The authenticated browser specs are not run in CI.** `e2e/specs/dashboard.spec.ts`
  needs a signed-in session, so it skips unless `E2E_STORAGE_STATE` is set, and
  CI deliberately does not set it. The unauthenticated marketing and web specs
  do run. See `e2e/README.md`.
- **A long serial run can lose its session.** The dashboard guard redirects to
  `/login` whenever a session lookup does not succeed — including a transient
  failure while the session cookie is being refreshed. Each browser spec passes
  on its own, but a long serial run against a development API can drop the
  session part-way and skip the rest. This guard is pre-existing behaviour that
  the redesign left alone; retrying once before redirecting would fix it.

## Marketing assets

- **`marketing/public/media/` ships empty.** The page references the clips and
  stills by path (`marketing/lib/media.ts`) and renders the poster state until
  they are added; a clip that fails to load falls back to a retry affordance.
  `marketing/public/media/README.md` lists the filenames, dimensions, encoding
  notes, and the provenance table (source URL, creator, download date, licence)
  each one needs before launch. The page is reviewed and correct in the
  placeholder state, but the 24-second hero recording and the four supporting
  clips are still outstanding.

## Missing UI

- **No dashboard UI for the delivery log.** `GET /api/webhooks/deliveries` and
  `POST /api/webhooks/deliveries/:id/replay` exist; `web/app/dashboard/webhooks`
  does not render them yet.

## Bootstrap and local transcoding

- **`dist/` is gitignored, so a checkout can be source-new and build-old.** `web`
  imports `@clipmux/uploader` and `@clipmux/player` from their built output, and
  nothing tracked in git proves that output matches `src/`. `scripts/dev.mjs`
  rebuilds a package whose `dist/` is older than any file in its `src/` before
  the dev servers start (and stops if that build fails), which covers
  `pnpm dev`/`dev:workers`/`dev:all`/`start`. It does **not** cover
  `pnpm dev:example` or a bare `next dev` in `web/` — those still need
  `pnpm --filter @clipmux/{uploader,player,server} build` first, which is what
  the README and CONTRIBUTING say. A `prepare`/`postinstall` build was rejected:
  it would run a full tsup + dts pass on every `pnpm install`, including in CI
  jobs that never build the dashboard.
- **No Windows launcher.** `scripts/bootstrap.sh` is Unix-only (macOS + Linux)
  and exits with a WSL pointer on Git Bash/MSYS/Cygwin. A PowerShell installer
  would have to reproduce the toolchain ladder (node/pnpm, `corepack`, the
  workspace install) and the wizard's `pnpm exec` calls — deferred until the Unix
  path has settled.
- **AI subtitles/chapters do not work with the self-hosted transcoder yet.** The
  agent image (`transcoding/Dockerfile.agent`) installs `requests` and the engine
  only: neither `faster-whisper` (subtitles) nor the `groq` client (chapters), both
  of which `transcoding/clipmux_transcoder/pipeline.py` reaches for when the job
  asks for them. Making it real is three changes that must land together: an
  opt-in `CLIPMUX_AGENT_EXTRAS=1` build arg installing `.[transcription,chapters]`
  (CI keeps building the extras-free image, which is what keeps the image small),
  the Whisper model pre-baked the way the Modal image does it, and
  `GROQ_API_KEY` passed through to the `transcoder` compose service. The wizard
  therefore asks about Groq **only** for the Modal provider and warns if a
  headless answers file sets the key on a self-hosted install.
- **The wizard cannot verify R2 S3 keys.** It checks presence and format; only a
  real S3 request proves them, and neither wrangler (OAuth) nor the wizard
  (no SigV4) makes one. `--deploy` and `GET /health/config` are the first real
  proof.
- **Neither Neon nor QStash is provisioned automatically.** Both are paste-a-value
  steps with a console link: provisioning them would mean storing a vendor API key
  in the wizard, for accounts the operator creates anyway.
- **`checks.database` and `--check` prove configuration shape, not connectivity.**
  `server/src/lib/config.ts` regex-matches `DATABASE_URL`, so `GET /health/config`
  reports `database: true` and `ready: true` while every real query fails — the
  health route even swallows the query error on purpose so a missing table cannot
  take down the endpoint the wizard reads. A live probe there would run on every
  `/health/config` call, which is why it was not added. The wizard covers the
  local case instead: `setup/src/devInfra.ts` inspects the dev container and
  probes host reachability, so `--check --target dev` and an interactive dev run
  report an unusable dev Postgres by name. A *remote* `DATABASE_URL`
  (`db.kind: "existing"` or Neon) is still only checked for shape and TCP.
- **A busy dev port is not detected by `up --wait`.** Docker can create
  `clipmux-dev-postgres` and fail to programme its port mapping while the
  container's own health check still passes, so `pnpm dev:infra` can exit `0`
  with nothing of ours listening on 5433, and `DATABASE_URL` reaches whichever
  server does hold the port. Compose cannot report this, which is why the wizard
  re-inspects the container *after* starting it rather than trusting the exit
  code, and why `docker ps --filter publish=5433` is the first debugging step in
  the README.
- **The delivery worker's bucket is global.** `delivery/wrangler.jsonc` holds one
  `bucket_name`, so two configurations with different transcoded buckets cannot
  both be deployed by this tooling — whichever deploys last wins, and the deploy
  report says which bucket is now in effect.

## Deferred by release

Per the agreed roadmap these were explicitly deferred, not forgotten.

- **Release 2 — integration (built, not published).** Three packages exist —
  `@clipmux/uploader` (resumable browser uploads, typed errors),
  `@clipmux/player` (React, token auto-refresh with backoff) and
  `@clipmux/server` (upload/playback tokens, video CRUD, webhook verification).
  The dashboard uploads and plays through them (its duplicate player component
  and Uppy-based uploader are gone), and `examples/nextjs-integration` compiles
  the documented flow in CI. Publishing is a `packages-v*` tag away; `NPM_TOKEN`
  must exist on the repository first. **Nothing is on npm yet.**
- **Release 2 follow-ups (not done).** The playback journal endpoint
  (`POST /api/playback/journal`) is still unauthenticated; `subtitle.generating`
  and `chapters.generating` sit in `WEBHOOK_EVENTS` with no dispatch site; and
  see the missing React 18 CI matrix above.
- **Release 3 — cost control.** Encoding presets, per-video measured time/bytes.
- **Release 4 — economics artifact.** The cost calculator, with benchmarks rather
  than assumed figures. Mux's 100k free delivery minutes and $20 credit must be
  modelled alongside R2's free tier or the comparison is misleading.
- **Release 5 — portability.** Additional storage backends. Worth noting the
  transcoder (`transcoding/main.py`) and delivery worker
  (`delivery/src/index.ts`) have **their own** storage paths — a hardcoded R2
  endpoint and a native R2 binding — so an API-only change cannot make the system
  provider-independent.
- **Three SaaS pilots.** Still the thing that should decide priorities.
