import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
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
        <span className="openvod-nav-title">
          <span className="openvod-nav-mark" aria-hidden="true" />
          <span className="openvod-nav-copy">
            <span>OpenVOD</span>
            <span className="openvod-nav-docs">Docs</span>
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
