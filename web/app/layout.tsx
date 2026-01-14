import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ClipMux | Video Streaming at 90% Less Cost",
  description:
    "The developer-first video platform that delivers Mux-quality streaming without the enterprise pricing. Simple API, global CDN, instant encoding. Start free today.",
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
    url: "https://clipmux.io",
    siteName: "ClipMux",
    title: "ClipMux | Video Streaming at 90% Less Cost",
    description:
      "The developer-first video platform that delivers Mux-quality streaming without the enterprise pricing.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "ClipMux - Affordable Video Streaming",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ClipMux | Video Streaming at 90% Less Cost",
    description:
      "The developer-first video platform that delivers Mux-quality streaming without the enterprise pricing.",
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
        className={`${inter.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
