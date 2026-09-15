import type { Metadata, Viewport } from "next";
import { Geist_Mono, Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ClipMux",
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/logo.svg",
  },
  description:
    "ClipMux is the open-source, self-hosted video platform: bring your own Cloudflare R2 and Modal keys to get Mux-style HLS/DASH ingestion, transcoding, signed playback and analytics.",
  keywords: [
    "video streaming",
    "VOD platform",
    "video encoding",
    "HLS streaming",
    "video API",
    "Mux alternative",
    "affordable video hosting",
  ],
  authors: [{ name: "ClipMux" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://clipmux.com",
    siteName: "ClipMux",
    title: "ClipMux | Open-source video infrastructure (bring your own keys)",
    description:
      "ClipMux is the open-source, self-hosted video platform: bring your own Cloudflare R2 and Modal keys to get Mux-style HLS/DASH ingestion, transcoding, signed playback and analytics.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "ClipMux - Open-source video platform",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ClipMux | Open-source video infrastructure (bring your own keys)",
    description:
      "ClipMux is the open-source, self-hosted video platform: bring your own Cloudflare R2 and Modal keys to get Mux-style HLS/DASH ingestion, transcoding, signed playback and analytics.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#171715",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        className={`${manrope.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
