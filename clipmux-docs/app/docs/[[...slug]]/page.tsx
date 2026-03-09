import { permanentRedirect } from 'next/navigation';

export default async function LegacyDocsPage(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await props.params;

  permanentRedirect(slug && slug.length > 0 ? `/${slug.join('/')}` : '/');
}
