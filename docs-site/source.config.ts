import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

/**
 * The syntax palette for every code block on the site.
 *
 * Fumadocs defaults to Shiki's `github-dark`, whose surface (`#24292e`) and blue
 * accents were the one part of the page that ignored the brand. This theme is
 * written as plain data rather than imported from a Shiki theme bundle, so the
 * build pulls in no extra package and the colours stay reviewable in one place.
 *
 * The token colours are the marketing site's `.tok-*` palette, and
 * `editor.background` is the dashboard's `.dash-code-block` surface — the same
 * value as `--code-surface` in `app/global.css`, so the figure and the Shiki
 * block behind it agree and no seam shows at the edges.
 */
const clipmuxTheme = {
  name: 'clipmux',
  type: 'dark' as const,
  colors: {
    'editor.background': '#141412',
    'editor.foreground': '#f4f2ed',
  },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: '#93908a', fontStyle: 'italic' },
    },
    {
      scope: ['keyword', 'storage', 'storage.type', 'keyword.operator.new'],
      settings: { foreground: '#fb923c' },
    },
    {
      scope: ['string', 'string.quoted', 'punctuation.definition.string'],
      settings: { foreground: '#9ed8a2' },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'variable.function',
        'meta.function-call',
      ],
      settings: { foreground: '#8ec7f0' },
    },
    {
      scope: ['entity.name.tag', 'support.class.component'],
      settings: { foreground: '#f0c48e' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.other'],
      settings: { foreground: '#fdba74' },
    },
    {
      scope: [
        'variable',
        'entity.name.type',
        'support.type',
        'entity.other.attribute-name',
      ],
      settings: { foreground: '#f4f2ed' },
    },
    {
      scope: ['punctuation', 'meta.brace'],
      settings: { foreground: '#9a968c' },
    },
  ],
};

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: clipmuxTheme,
        dark: clipmuxTheme,
      },
    },
  },
});
