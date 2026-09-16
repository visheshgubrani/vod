# clipmux-docs

The ClipMux documentation site — a Next.js 16 app built on
[Fumadocs](https://fumadocs.dev). Content is licensed
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); the site software is
Apache-2.0 like the rest of the repository.

```bash
pnpm --filter clipmux-docs dev        # :3000, or :3001 when the dashboard has it
pnpm --filter clipmux-docs build      # the authoritative check — run this before you push
pnpm --filter clipmux-docs typecheck  # fumadocs-mdx + next typegen + tsc
pnpm --filter clipmux-docs lint
```

`next dev` quietly moves to `:3001` (and onward) when `:3000` is taken, which it
will be if you are also running `pnpm dev` for the dashboard.

`build` is authoritative rather than `dev`: it compiles every MDX page, runs the
component tree through TypeScript, and fails on a malformed block. Anything that
breaks the site breaks the build.

## Where content lives

```
content/docs/
  meta.json                  # sidebar order for this level
  index.mdx                  # the landing page, at /
  *.mdx                      # top-level pages, at /<slug>
  integrations/
    meta.json
    index.mdx                # /integrations
    nextjs.mdx               # /integrations/nextjs
  api-reference/
    meta.json
    index.mdx
```

Docs render at the **root**, not under `/docs` — `lib/source.ts` sets
`baseUrl: '/'`, and `next.config.mjs` permanently redirects `/docs/*` to the
matching root path for older links. A new file is a new URL: to keep an existing
link working, keep the filename.

## Adding a page

1. Create `content/docs/<slug>.mdx` with `title` and `description` frontmatter.
   Both are required by the schema in `source.config.ts`.
2. **Add the slug to the nearest `meta.json`.** A page that is not listed falls
   to the `...` catch-all at the bottom of the sidebar — still reachable, but
   unordered and probably in the wrong section.
3. Run `pnpm --filter clipmux-docs build`.

### `meta.json` ordering

```json
{
  "title": "Framework integrations",
  "pages": ["index", "nextjs", "react-vite", "nuxt", "sveltekit", "node-backend", "..."]
}
```

- Entries are file and folder names, without the `.mdx` extension.
- `"---Get started---"` inserts a labelled section separator. An icon is
  optional: `"---[Rocket]Get started---"`.
- `"..."` is the rest of the directory in alphabetical order. **Keep it, and keep
  it last** — it is what stops a newly added page from disappearing.

## Writing conventions

- **Every claim must be verifiable in this repository.** Endpoint fields come
  from `server/src/routes/`, error codes from `sdk/src/errors.ts` and
  `server-sdk/src/errors.ts`, environment variables from
  `server/.dev.vars.example` and `.env.example`.
- **Framework snippets must stay consistent with `examples/nextjs-integration`,
  which is compiled on every commit.** If a guide and that example disagree, the
  example is right.
- **Never invent a code, field or variable.** If it is not in the source, it does
  not go in the docs. Two codes were removed during review for exactly this
  reason.
- **Do not bounce the reader to the GitHub README** for setup content that
  belongs here. The README is a summary; this site is the reference. Deep
  references into `docs/*.md` (the delivery contract, the agent protocol) are
  fine, because those are contracts rather than getting-started material.
- **Link relatively** — `/upload`, not `/docs/upload`. The `/docs` form still
  works via redirect, but it is an extra hop.
- Cross-page anchors are generated from headings by slugifying them. Verify an
  anchor after you change a heading; `grep -o 'id="[a-z0-9-]*"'` against the
  built HTML in `.next/server/app/` is the quick way.

## Components

`mdx-components.tsx` registers `Callout`, `Cards`/`Card`, `Steps`/`Step`,
`Tabs`/`Tab`, `Files`/`File`/`Folder`, `Accordions`/`Accordion` and `TypeTable`
for every page, so MDX files do not import them. Add a new Fumadocs component
there rather than importing per page.

## Styling

There is **no `tailwind.config.ts`** — deliberately. Fumadocs ships its own
Tailwind preset and CSS entry points, and `app/global.css` is the single place
this site overrides them. It holds four things, in order:

1. **Tokens.** `:root` / `.dark` define the brand palette, then map it onto the
   `--color-fd-*` namespace Fumadocs reads. The values are the dashboard's
   (`web/app/globals.css`), transcribed by hand: the apps deploy independently
   and deliberately do not import from one another, so a change in one is a
   change to make in the other. The mapping is intentionally unlayered so it
   beats the `@theme` defaults in `fumadocs-ui/css/lib/default-colors.css`.
2. **Shell geometry**, on `.clipmux-shell`. That class is applied through
   `containerProps` in `lib/layout.shared.tsx`, which is the one `DocsLayout` this
   site renders.
3. **Prose** — heading rhythm, inline code, code blocks and tables, all scoped to
   `#nd-page .prose`.
4. **Chrome** — the sidebar rail, its section labels and footer, and the TOC.

### Four things that will bite you

- **Two `!important`s are load-bearing, not laziness.** Fumadocs sizes the
  sidebar and TOC with arbitrary-property utilities
  (`md:layout:[--fd-sidebar-width:268px]`, `xl:layout:[--fd-toc-width:268px]`) and
  paints the active sidebar entry with `data-[active=true]:text-fd-primary`. All
  three live in `@layer utilities`, so unlayered rules here lose to them. The same
  applies to `#nd-sidebar`'s own width: Fumadocs' `w-(--fd-sidebar-width)` utility
  wins on the rail and stretches it across both of its grid columns, whatever the
  variable says.
- **The grid template is overridden on purpose.** Fumadocs sizes the article
  column as `calc(var(--fd-layout-width, 97rem) - sidebar - toc)`. When the
  viewport is *narrower* than `--fd-layout-width`, the sidebar spans two flexible
  columns and grows past its own width — a 329px rail out of a 248px variable. The
  `grid-template-columns` rules on `.clipmux-shell` replace that `calc()` with
  `minmax(0, 1fr)` per breakpoint so the article absorbs the difference.
- **`table-layout: fixed` on `table` is a fix, not a preference.** These pages put
  long inline code and prose in adjacent cells; under `auto` the browser collapses
  the first column to roughly its own padding.
- **The site is dark-only and `next-themes` is disabled.** `app/layout.tsx` pins
  `dark` on `<html>` and passes `theme={{ enabled: false }}` to `RootProvider`.
  Left on, `RootProvider` defaults to `theme="system"` and rewrites the class on
  the first visit, so a visitor whose OS prefers light gets the light tokens while
  the code blocks stay dark. Enabling a theme toggle later means deleting that
  prop, giving `<html>` a class the script can remove, and checking the code-block
  palette in both modes.

Syntax highlighting is configured in `source.config.ts` as an inline Shiki theme
(`clipmux`), so the code surface matches `--code-surface` and the token colours
match the marketing site's `.tok-*` palette. It is plain data rather than an
imported theme bundle, which keeps the build free of an extra package.

## Gotchas

- **The root `.gitignore` allowlists this directory.** A new **top-level**
  directory under `docs-site/` must be added to that allowlist or it will not be
  committed. Directories under `content/`, `app/`, `components/` and `lib/` are
  already covered. (The allowlist exists because pnpm intermittently
  materializes a store farm at the `docs-site/` root.)
- **MDX braces are expressions.** `{#my-anchor}` is not valid — that is JSX
  syntax, and MDX tries to parse it as JavaScript. Fumadocs slugs headings
  automatically, so write the heading and let it generate the id.
- **`fumadocs-mdx` must run before `tsc`** to generate `.source/`. The
  `typecheck` script does that explicitly rather than relying on `postinstall`.
- **`LayoutProps<'/'>` comes from `next typegen`**, so `typecheck` runs it before
  `tsc`. Skipping it fails on the layout files.

## Rendering

| Route | What it serves |
| --- | --- |
| `/` | The `index.mdx` landing page |
| `/<slug>` | Any other docs page |
| `/llms.txt` | A page index for LLM crawlers |
| `/llms-full.txt` | Every page concatenated |
| `/<slug>.mdx` | The raw Markdown for one page — powers the "Copy Markdown" button |
| `/api/search` | Fumadocs' server-side search |
| `/og/docs/<slug>/image.webp` | Generated Open Graph images |

The **Open** dropdown on each page (`components/ai/page-actions.tsx`) links to
GitHub, ChatGPT, Claude and Cursor. Its GitHub URL is derived from `page.path`
in `lib/docs.ts`, which stays correct for nested folders and `index.mdx`.
