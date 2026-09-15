# Browser coverage

Playwright specs for the two front ends. They cover the behaviour a build or a
unit test cannot prove: media fallback policy, tab semantics, anchor navigation,
reduced-motion and no-JavaScript guarantees, and the dashboard interactions the
redesign changed.

```bash
pnpm test:e2e                      # every project
pnpm test:e2e --project=marketing  # one project
pnpm test:e2e:install              # first run on a new machine
```

The config starts both apps itself (`webServer`), or reuses them if they are
already running on ports 3000 and 3004.

## Projects

| Project | Spec | Needs | What it proves |
|---|---|---|---|
| `marketing` | `specs/marketing.spec.ts` | nothing | Hero copy and CTAs, the tour link moving focus, the missing-clip and refused-autoplay fallbacks, tab semantics and copy feedback, anchor offsets under the sticky header, FAQ and no-JavaScript content, reduced motion, no horizontal overflow at 360–1440px |
| `web` | `specs/web-smoke.spec.ts` | nothing | The public surfaces render without overflow, login fields are labelled and every control clears 44px, `/dashboard` still guards unauthenticated visitors, and the **retired palette appears nowhere in the built CSS** |
| `dashboard` | `specs/dashboard.spec.ts` | `E2E_STORAGE_STATE` | Thumbnail and row sizing, the row-actions menu, the delete confirmation (including Escape), search, the upload dialog, the 248px rail and 32px padding, the mobile drawer's focus behaviour, and playback-first video detail |

`marketing` runs against the placeholder-free checkout on purpose: `public/media`
is supplied separately, so the *missing asset* path is the default state and has
to stay usable.

## Running the authenticated specs

They need a session, so they are skipped unless `E2E_STORAGE_STATE` points at a
Playwright storage-state file:

```bash
# 1. Start the API and web app, and sign up a throwaway user.
pnpm dev:infra && pnpm db:migrate
pnpm --filter vod-api dev &
pnpm --filter web dev &

# 2. Capture a session. Any Playwright script will do:
#    await context.storageState({ path: ".tmp-auth.json" })

E2E_STORAGE_STATE=$PWD/.tmp-auth.json pnpm test:e2e --project=dashboard
```

Notes for whoever runs this next:

- **Serial by design.** The three dashboard describes share one context and one
  page. A session is a single live session; replaying one storage-state file
  into several contexts at once invalidates it.
- **A stale file skips, it does not fail.** If the API rejects the session the
  spec calls `test.skip()` with a message, because an expired cookie is an
  environment problem rather than a regression.
- **Long runs can lose the session.** The dashboard guard sends a visitor to
  `/login` whenever a session lookup does not succeed, including a transient one
  while the cookie is being refreshed. Each spec therefore passes on its own but
  a long serial run against a development API can drop the session part-way —
  this is worth knowing before reading a `skipped` line as a product bug.
- Recorded evidence for the authenticated flows lives in the redesign handoff;
  a real-environment smoke test after deploy is still the check that matters.

## Screenshots

Screenshots are not committed. To review the layouts, point a Playwright script
at the running servers and write to a local directory — the specs already assert
the measurable properties (rail width, content padding, thumbnail ratio, control
heights), so a screenshot is for taste, not for verification.
