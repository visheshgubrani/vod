# ClipMux marketing site

The standalone marketing site lives here so its typography, motion lifecycle,
and public conversion links do not couple to the dashboard. It deploys on its
own; it never imports from `web/`.

```bash
pnpm --filter clipmux-marketing dev      # http://localhost:3004
pnpm --filter clipmux-marketing build
pnpm --filter clipmux-marketing typecheck
pnpm --filter clipmux-marketing lint
```

Production builds require the destinations in [`.env.example`](./.env.example).
They are deployment configuration: the app does not provide form APIs, billing,
authentication, or hosted waitlist storage. Set
`MARKETING_ALLOW_LOCAL_DEFAULTS=1` to build with the local defaults.

## Design system

Tokens live at the top of [`app/globals.css`](./app/globals.css) — warm ivory
surfaces, a charcoal section colour, and a burnt-orange brand used only for
actions and emphasis. Manrope carries the interface, Geist Mono the technical
values, and Instrument Serif appears only in the two display headlines.

The dashboard uses the same values but declares them independently, so the two
apps stay deployable on their own.

## Media

Every image and video path is named once, in [`lib/media.ts`](./lib/media.ts),
and the files themselves live in `public/media/`. That directory ships empty:
[`public/media/README.md`](./public/media/README.md) lists the exact filenames,
dimensions, encoding notes, and the provenance table each clip needs before
launch. Until the files are added, the page renders the poster state and, if a
clip fails to load, a retry affordance.

## Motion

GSAP + ScrollTrigger drive the workflow sequence; Motion handles local UI
transitions. Two rules hold everywhere:

- animation only ever changes `opacity` and `transform`, so a section that has
  not been revealed yet is still in the accessibility tree; and
- the rendered markup is the *end* state, so the page reads correctly with
  reduced motion, without JavaScript, or if a chunk fails to load.

Scrolling is native — there is no smooth-scroll interception.
