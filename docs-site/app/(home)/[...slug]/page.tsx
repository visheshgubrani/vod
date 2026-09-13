import { DocsPageView } from '@/components/docs-page';
import { getPageMetadata, getResolvedPage } from '@/lib/docs';
import { source } from '@/lib/source';
import type { Metadata } from 'next';

export default async function DocsCatchAllPage(props: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await props.params;
  const page = getResolvedPage(slug);

  return <DocsPageView page={page} />;
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await props.params;

  return getPageMetadata(slug);
}
