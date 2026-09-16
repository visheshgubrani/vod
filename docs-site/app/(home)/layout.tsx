import { ClipMuxDocsLayout } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/'>) {
  return <ClipMuxDocsLayout>{children}</ClipMuxDocsLayout>;
}
