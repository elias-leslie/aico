import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function importMiddleware() {
  vi.resetModules()
  return import('./middleware')
}

describe('middleware', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('does not redirect protected routes when auth mode is none', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'none')
    const { middleware } = await importMiddleware()

    const response = middleware(new NextRequest('http://localhost:3002/'))

    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-")
    expect(response.headers.get('x-nonce')).toBeTruthy()
  })

  it('redirects protected routes to login when password auth has no session cookie', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'password')
    const { middleware } = await importMiddleware()

    const response = middleware(new NextRequest('http://localhost:3002/notes'))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3002/login?next=%2Fnotes',
    )
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-")
  })

  it('allows protected routes when password auth has the session cookie', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'password')
    const { middleware } = await importMiddleware()

    const response = middleware(
      new NextRequest('http://localhost:3002/', {
        headers: {
          cookie: 'a_term_session=present',
        },
      }),
    )

    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-")
    expect(response.headers.get('x-nonce')).toBeTruthy()
  })
})
