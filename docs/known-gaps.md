# Known gaps and deferred work

Standing record of what OpenVOD deliberately does **not** do yet, and what is
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
- **No React 18 matrix in CI**, despite `@openvod/player` declaring a `>=18` peer
  range. CI exercises React 19 only.

## Missing UI

- **No dashboard UI for the delivery log.** `GET /api/webhooks/deliveries` and
  `POST /api/webhooks/deliveries/:id/replay` exist; `web/app/dashboard/webhooks`
  does not render them yet.

## Deferred by release

Per the agreed roadmap these were explicitly deferred, not forgotten.

- **Release 2 — integration (built, not published).** Three packages exist —
  `@openvod/uploader` (resumable browser uploads, typed errors),
  `@openvod/player` (React, token auto-refresh with backoff) and
  `@openvod/server` (upload/playback tokens, video CRUD, webhook verification).
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
