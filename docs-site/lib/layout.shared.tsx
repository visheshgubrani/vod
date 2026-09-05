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
