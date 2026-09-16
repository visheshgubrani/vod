import { ClipMuxDocsLayout } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return <ClipMuxDocsLayout>{children}</ClipMuxDocsLayout>;
}
