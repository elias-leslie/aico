import type { MetadataRoute } from 'next'
import { APP_THEME_COLORS } from '@/lib/app-theme'
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
} from '@/lib/project-branding'

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: PRODUCT_NAME,
    short_name: PRODUCT_SHORT_NAME,
    description: PRODUCT_DESCRIPTION,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: APP_THEME_COLORS.dark,
    theme_color: APP_THEME_COLORS.dark,
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
}
