import './globals.css'
import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  metadataBase: new URL('https://quorvel.tech'),
  title: 'Quorvel — Hope Is Not a Retry Strategy',
  description:
    'Quorvel is the reliability layer for AI agents: a durable ledger, exactly-once execution, human-in-the-loop approvals, and crash-safe recovery.',
  icons: { icon: '/assets/favicon.png', apple: '/assets/favicon.png' },
  openGraph: {
    type: 'website',
    url: 'https://quorvel.tech/',
    title: 'Quorvel — Hope Is Not a Retry Strategy',
    description:
      'The reliability layer for AI agents: durable ledger, exactly-once execution, human-in-the-loop approvals, and crash-safe recovery.',
    images: [{ url: '/assets/og.jpg', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Quorvel — Hope Is Not a Retry Strategy',
    description:
      'The reliability layer for AI agents — durable ledger, exactly-once, human approvals, crash-safe recovery.',
    images: ['/assets/og.jpg'],
  },
}

export const viewport: Viewport = { themeColor: '#f6eede' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,400..900&family=Caveat:wght@500;700&family=Nunito:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;450;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
