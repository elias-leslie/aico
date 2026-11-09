import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import RootLayout, { metadata } from './layout'

vi.mock('@/components/frame/AppFrame', () => ({
  AppFrame: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('./providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => children,
}))

describe('RootLayout', () => {
  it('fetches the manifest with credentials so the app installs behind Cloudflare Access', () => {
    const html = renderToStaticMarkup(RootLayout({ children: null }))
    expect(html).toContain(
      '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"/>',
    )
  })
})

describe('layout metadata', () => {
  it('shows the favicon in tabs and a 180px full-bleed icon for iOS', () => {
    expect(metadata.icons).toMatchObject({
      icon: [{ url: '/favicon.ico' }],
      apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
    })
  })
})

describe('manifest route', () => {
  it('serves an installable manifest', async () => {
    const { GET } = await import('./manifest.webmanifest/route')
    const response = GET()
    expect(response.headers.get('Content-Type')).toBe(
      'application/manifest+json',
    )
    const body = await response.json()
    expect(body).toMatchObject({
      name: 'Aico',
      display: 'standalone',
      start_url: '/',
    })
    expect(body.shortcuts).toEqual([{ name: 'Notes', url: '/notes' }])
    expect(
      body.icons.map((icon: { sizes: string; purpose: string }) => [
        icon.sizes,
        icon.purpose,
      ]),
    ).toEqual([
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ])
  })
})
