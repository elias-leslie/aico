import type { Metadata, Viewport } from 'next'
import { AppFrame } from '@/components/frame/AppFrame'
import { LANTERN_RIM } from '@/lib/constants/lantern'
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
} from '@/lib/project-branding'
import './globals.css'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: PRODUCT_DESCRIPTION,
  applicationName: PRODUCT_NAME,
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: PRODUCT_SHORT_NAME,
  },
  icons: {
    // The tab icon is the small-size lantern in favicon.ico; the 192/512 PNGs are the install icons (manifest).
    icon: [{ url: '/favicon.ico', sizes: '16x16 32x32 48x48' }],
    apple: [
      {
        url: '/icons/apple-touch-icon.png',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  },
}

export const viewport: Viewport = {
  themeColor: LANTERN_RIM,
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Cloudflare Access guards every path, so the browser must send the
            login cookie with the manifest fetch or the app can't be installed. */}
        <link
          rel="manifest"
          href="/manifest.webmanifest"
          crossOrigin="use-credentials"
        />
      </head>
      <body>
        <Providers>
          <AppFrame>{children}</AppFrame>
        </Providers>
      </body>
    </html>
  )
}
