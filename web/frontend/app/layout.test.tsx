import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import RootLayout from './layout'

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
}))

vi.mock('next/script', () => ({
  default: () => null,
}))

vi.mock('./providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => children,
}))

describe('RootLayout', () => {
  it('fetches the manifest with credentials so the app installs behind Cloudflare Access', async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: null }))
    expect(html).toContain(
      '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"/>',
    )
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
    expect(body.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual([
      '192x192',
      '512x512',
    ])
  })
})
