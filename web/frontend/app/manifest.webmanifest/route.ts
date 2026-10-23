import type { MetadataRoute } from 'next'
import { LANTERN_RIM } from '@/lib/constants/lantern'
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
} from '@/lib/project-branding'

// A plain route, not Next's manifest.ts convention: that one adds its own
// <link rel="manifest"> without crossorigin, which the browser picks first and
// fetches without the Cloudflare Access cookie. layout.tsx links this one.
export const dynamic = 'force-static'

export const MANIFEST: MetadataRoute.Manifest = {
  id: '/',
  name: PRODUCT_NAME,
  short_name: PRODUCT_SHORT_NAME,
  description: PRODUCT_DESCRIPTION,
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: LANTERN_RIM,
  theme_color: LANTERN_RIM,
  icons: [
    {
      src: '/icons/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
    },
    {
      src: '/icons/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
    },
  ],
}

export function GET(): Response {
  return new Response(JSON.stringify(MANIFEST), {
    headers: { 'Content-Type': 'application/manifest+json' },
  })
}
