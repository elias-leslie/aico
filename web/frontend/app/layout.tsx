import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { JetBrains_Mono, DM_Sans } from 'next/font/google'
import Script from 'next/script'
import { APP_THEME_COLORS, APP_THEME_INIT_SCRIPT } from '@/lib/app-theme'
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
} from '@/lib/project-branding'
import { PWA_REGISTER_SCRIPT } from '@/lib/runtime-scripts'
import './globals.css'
import { Providers } from './providers'

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
})

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: PRODUCT_DESCRIPTION,
  applicationName: PRODUCT_NAME,
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: PRODUCT_SHORT_NAME,
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: APP_THEME_COLORS.dark },
    { media: '(prefers-color-scheme: light)', color: APP_THEME_COLORS.light },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script id="app-theme-init" nonce={nonce} strategy="beforeInteractive">
          {APP_THEME_INIT_SCRIPT}
        </Script>
        <Script id="pwa-register" nonce={nonce} strategy="afterInteractive">
          {PWA_REGISTER_SCRIPT}
        </Script>
      </head>
      <body className={`${jetbrainsMono.variable} ${dmSans.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
