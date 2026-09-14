# openvod-docs

The OpenVOD documentation site — a Next.js 16 app built on
[Fumadocs](https://fumadocs.dev). Content is licensed
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); the site software is
Apache-2.0 like the rest of the repository.

```bash
pnpm --filter openvod-docs dev        # :3000, or :3001 when the dashboard has it
pnpm --filter openvod-docs build      # the authoritative check — run this before you push
pnpm --filter openvod-docs typecheck  # fumadocs-mdx + next typegen + tsc
pnpm --filter openvod-docs lint
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
3. Run `pnpm --filter openvod-docs build`.

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
