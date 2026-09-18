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
or authentication. Set `MARKETING_ALLOW_LOCAL_DEFAULTS=1` to build with the
local defaults.

## The page

The hero is the only display moment, and the only media on the page. Everything
below it is one left-aligned column that tells the same story in the same voice:

| Section | Anchor | What it carries |
|---|---|---|
| Ownership | `#ownership` | Own the media, choose the compute, control access |
| Workflow | `#workflow` | Upload → process → play, in three columns |
| Platform | `#platform` | One example library and three behaviours |
| Developer experience | `#developers` | One browser-upload example, from the compiled integration |
| Self-hosting | `#hosting` | Apache-2.0, infrastructure costs, and the bootstrap command |
| Questions | `#faq` | Native `<details>` answers |

There is no managed-hosting or enterprise offer, and no pricing of any kind:
self-hosting is the only path the product ships today.

## Design system

Tokens live at the top of [`app/globals.css`](./app/globals.css) — warm ivory
surfaces, a charcoal section colour, and a burnt-orange brand used only for
actions and emphasis. Manrope carries the interface, Geist Mono the technical
values, and Instrument Serif appears only in the two display headlines.

Three rules keep the page consistent, and are worth keeping when editing:

- **One measure.** `--container` is the single content width for the nav, the
  hero, every section, and the closing band, so everything shares one left edge.
- **Two type scales.** `--step-hero` / `--step-body` belong to the hero and the
  closing band; `--step-h2` / `--step-h3` / `--step-prose` / `--step-meta` /
  `--step-micro` are the content scale. Redesigning the page below the hero must
  never resize the display moments.
- **One bordered surface per idea.** Below the hero, only the library preview
  and the code panel carry a border and a background. Every other group is
  whitespace under a 1px rule, so no block looks more important than it is.

Code renders through `components/code-panel.tsx` and nothing else, so two samples
cannot drift into two sizes or two palettes.

The dashboard uses the same colour values but declares them independently, so the
two apps stay deployable on their own.

## Media

The page references exactly one asset: the hero recording, named once in
[`lib/media.ts`](./lib/media.ts). `public/media/` ships empty and
[`public/media/README.md`](./public/media/README.md) lists the exact filenames,
dimensions, and encoding notes it needs. Until the files are added, the hero
renders its poster state and, if the clip fails to load, a retry affordance.

There is deliberately no imagery below the hero: a checkout without
`public/media` renders a complete page instead of broken thumbnails, and the
browser spec asserts it (`main img` count 0).

## Motion

GSAP drives a single hero entrance; Motion handles the local, user-triggered
transitions (the mobile menu and the FAQ open/close). Two rules hold everywhere:

- animation only ever changes `opacity` and `transform`, so nothing is removed
  from the accessibility tree; and
- the rendered markup is the *end* state, so the page reads correctly with
  reduced motion, without JavaScript, or if a chunk fails to load. No section
  below the hero has an entrance animation, and ScrollTrigger is not used.

Scrolling is native — there is no smooth-scroll interception.
