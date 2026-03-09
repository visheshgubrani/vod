import { DocsPageView } from '@/components/docs-page';
import { getPageMetadata, getResolvedPage } from '@/lib/docs';
import type { Metadata } from 'next';

export default function HomePage() {
  const page = getResolvedPage();

  return <DocsPageView page={page} />;
}

export function generateMetadata(): Metadata {
  return getPageMetadata();
}
