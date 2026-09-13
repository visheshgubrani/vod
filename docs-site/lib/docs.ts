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
