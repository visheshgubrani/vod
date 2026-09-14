import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import { siteConfig } from "@/lib/site-config";
import "./globals.css";

const manrope = localFont({
  variable: "--font-manrope",
  display: "swap",
  src: [
    { path: "./fonts/manrope-400.ttf", weight: "400", style: "normal" },
    { path: "./fonts/manrope-500.ttf", weight: "500", style: "normal" },
    { path: "./fonts/manrope-600.ttf", weight: "600", style: "normal" },
    { path: "./fonts/manrope-700.ttf", weight: "700", style: "normal" },
    { path: "./fonts/manrope-800.ttf", weight: "800", style: "normal" },
  ],
});

const instrumentSerif = localFont({
  variable: "--font-instrument-serif",
  display: "swap",
  src: [
    { path: "./fonts/instrument-serif-regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/instrument-serif-italic.ttf", weight: "400", style: "italic" },
  ],
});

const geistMono = localFont({
  variable: "--font-geist-mono",
  display: "swap",
  src: [
    { path: "./fonts/geist-mono-400.ttf", weight: "400", style: "normal" },
    { path: "./fonts/geist-mono-700.ttf", weight: "700", style: "normal" },
  ],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.canonicalOrigin),
  title: {
    default: "OpenVOD — Your video. Your platform.",
    template: "%s | OpenVOD",
  },
  description:
    "Open-source video infrastructure for products that need upload, transcoding, and playback on infrastructure they control.",
  alternates: {
    canonical: "/",
  },
  applicationName: "OpenVOD",
  keywords: ["open-source video", "video infrastructure", "self-hosted VOD", "HLS", "video API"],
  authors: [{ name: "OpenVOD" }],
  creator: "OpenVOD",
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "OpenVOD",
    title: "OpenVOD — Your video. Your platform.",
    description:
      "Upload, transcode, and stream with a complete open-source video platform.",
    images: [{ url: "/opengraph-image" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenVOD — Your video. Your platform.",
    description:
      "Open-source video infrastructure on infrastructure you control.",
    images: ["/opengraph-image"],
  },
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#F7F5F0",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} ${instrumentSerif.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
