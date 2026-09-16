import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { DocsLayout, type DocsLayoutProps } from 'fumadocs-ui/layouts/docs';
import { BookOpen, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { REPO_URL } from '@/lib/docs';
import { source } from '@/lib/source';

/**
 * Shell options shared by every page.
 *
 * `themeSwitch` is off because the site is dark-only by design — `app/layout.tsx`
 * pins `dark` on `<html>` and disables `next-themes`, so a toggle would do nothing.
 */
function baseOptions(): BaseLayoutProps {
  return {
    links: [
      {
        text: 'Quickstart',
        url: '/quickstart',
        active: 'nested-url',
      },
      {
        text: 'Integrations',
        url: '/integrations',
        active: 'nested-url',
      },
      {
        text: 'API reference',
        url: '/api-reference',
        active: 'nested-url',
      },
    ],
    nav: {
      title: (
        <span className="clipmux-nav-title">
          <BrandMark />
          <span className="clipmux-nav-copy">
            <span>ClipMux</span>
            <span className="clipmux-nav-docs">Docs</span>
          </span>
        </span>
      ),
      transparentMode: 'top',
    },
    searchToggle: {
      enabled: true,
    },
    themeSwitch: {
      enabled: false,
    },
  };
}

/**
 * The one `DocsLayout` this site renders.
 *
 * Both route groups wrap their pages in it, so the shell geometry and the sidebar
 * chrome are declared once instead of being repeated in two `layout.tsx` files
 * that could drift apart.
 *
 * `containerProps` carries `clipmux-shell`, which is where `app/global.css` sets
 * `--fd-layout-width`, `--fd-sidebar-col`, `--fd-sidebar-width`, `--fd-toc-width`
 * and the grid template those feed. See the Styling section of the README before
 * changing any of it.
 */
export function ClipMuxDocsLayout({ children }: { children: ReactNode }) {
  const options: DocsLayoutProps = {
    tree: source.getPageTree(),
    containerProps: { className: 'clipmux-shell' },
    sidebar: {
      // A rail with its own surface that carries the brand: a collapsed rail
      // sliding over the article is a state this site does not want reachable.
      collapsible: false,
      footer: (
        <div className="clipmux-sidebar-footer">
          <a href={REPO_URL} rel="noreferrer noopener" target="_blank">
            <ExternalLink aria-hidden="true" />
            GitHub
          </a>
          <a href="/">
            <BookOpen aria-hidden="true" />
            Documentation home
          </a>
        </div>
      ),
    },
    ...baseOptions(),
  };

  return <DocsLayout {...options}>{children}</DocsLayout>;
}
