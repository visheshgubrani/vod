import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    links: [
      {
        text: 'Overview',
        url: '/overview',
        active: 'nested-url',
      },
    ],
    nav: {
      title: (
        <span className="clipmux-nav-title">
          <span className="clipmux-nav-mark" aria-hidden="true" />
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
