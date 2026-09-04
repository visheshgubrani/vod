import type { Metadata, Viewport } from "next";
import {
  Chivo,
  Commissioner,
  Geist_Mono,
  Inter,
  PT_Serif,
} from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const commissioner = Commissioner({
  variable: "--font-commissioner",
  subsets: ["latin"],
  display: "swap",
});

const ptSerif = PT_Serif({
  variable: "--font-pt-serif",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

const chivo = Chivo({
  variable: "--font-chivo",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenVOD",
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/logo.svg",
  },
  description:
    "OpenVOD is the open-source, self-hosted video platform: bring your own Cloudflare R2 and Modal keys to get Mux-style HLS/DASH ingestion, transcoding, signed playback and analytics.",
  keywords: [
    "video streaming",
    "VOD platform",
    "video encoding",
    "HLS streaming",
    "video API",
    "Mux alternative",
    "affordable video hosting",
  ],
  authors: [{ name: "OpenVOD" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://openvod.dev",
    siteName: "OpenVOD",
    title: "OpenVOD | Open-source video infrastructure (bring your own keys)",
    description:
      "OpenVOD is the open-source, self-hosted video platform: bring your own Cloudflare R2 and Modal keys to get Mux-style HLS/DASH ingestion, transcoding, signed playback and analytics.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "OpenVOD - Open-source video platform",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenVOD | Open-source video infrastructure (bring your own keys)",
    description:
      "OpenVOD is the open-source, self-hosted video platform: bring your own Cloudflare R2 and Modal keys to get Mux-style HLS/DASH ingestion, transcoding, signed playback and analytics.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#7c3aed",
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
        className={`${inter.variable} ${commissioner.variable} ${ptSerif.variable} ${chivo.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
