import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Geist_Mono, Manrope } from 'next/font/google';
import type { Metadata, Viewport } from 'next';

/** The dashboard and marketing site both set Manrope; the docs follow them. */
const manrope = Manrope({
  variable: '--font-manrope',
  display: 'swap',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'ClipMux Docs',
    template: '%s | ClipMux Docs',
  },
  description:
    'Documentation for ClipMux, the open-source BYOK VOD platform for video ingestion, encoding, playback, and delivery.',
};

export const viewport: Viewport = {
  themeColor: '#171715',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`dark scroll-smooth ${manrope.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="clipmux-docs flex min-h-screen flex-col antialiased">
        {/*
          The docs are dark-only, so `next-themes` is switched off. Left on, its
          default `theme="system"` rewrites the class on `<html>` on the first
          visit — a visitor whose OS prefers light would get the light tokens in
          `app/global.css` while the code-block palette stayed dark.
        */}
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
