import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OpenVOD · Next.js integration example',
  description:
    'End-to-end OpenVOD demo: browser upload, playback token, player and webhooks.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
