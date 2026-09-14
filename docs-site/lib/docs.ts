import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { InferPageType } from 'fumadocs-core/source';
import { getPageImage, source } from '@/lib/source';

export type DocsSourcePage = InferPageType<typeof source>;

export function getResolvedPage(slug?: string[]): DocsSourcePage {
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  return page;
}

export function getMarkdownUrl(page: DocsSourcePage): string {
  return page.slugs.length === 0 ? '/index.mdx' : `${page.url}.mdx`;
}

/** Source of truth for every "edit this page" link on the site. */
export const REPO_URL = 'https://github.com/visheshgubrani/vod';

/**
 * The `.mdx` file backing a page, on GitHub.
 *
 * `page.path` is the file path relative to `content/docs`, so it stays correct
 * for nested folders and for `index.mdx`, which both lose a URL segment.
 */
export function getGitHubUrl(page: DocsSourcePage): string {
  return `${REPO_URL}/blob/main/docs-site/content/docs/${page.path}`;
}

export function getPageMetadata(slug?: string[]): Metadata {
  const page = getResolvedPage(slug);

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
  };
}
