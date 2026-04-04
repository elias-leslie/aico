import type { Metadata, Viewport } from 'next'
import { JetBrains_Mono, DM_Sans } from 'next/font/google'
import { APP_THEME_COLORS, APP_THEME_INIT_SCRIPT } from '@/lib/app-theme'
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
  title: 'Terminal - SummitFlow',
  description: 'Standalone terminal application for SummitFlow',
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: APP_THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${jetbrainsMono.variable} ${dmSans.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
