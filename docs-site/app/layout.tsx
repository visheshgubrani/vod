import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Commissioner, Geist_Mono, Inter } from 'next/font/google';
import type { Metadata, Viewport } from 'next';

const inter = Inter({
  variable: '--font-inter',
  display: 'swap',
  subsets: ['latin'],
});

const commissioner = Commissioner({
  variable: '--font-commissioner',
  display: 'swap',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'OpenVOD Docs',
    template: '%s | OpenVOD Docs',
  },
  description:
    'Documentation for OpenVOD, the open-source BYOK VOD platform for video ingestion, encoding, playback, and delivery.',
};

export const viewport: Viewport = {
  themeColor: '#704fd5',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`dark scroll-smooth ${inter.variable} ${commissioner.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="openvod-docs flex min-h-screen flex-col antialiased">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
