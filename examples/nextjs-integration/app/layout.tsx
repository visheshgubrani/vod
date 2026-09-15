import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ClipMux · Next.js integration example',
  description:
    'End-to-end ClipMux demo: browser upload, playback token, player and webhooks.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
