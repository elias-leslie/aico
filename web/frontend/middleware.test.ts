import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function importMiddleware() {
  vi.resetModules()
  return import('./middleware')
}

function getDirective(response: Response, name: string): string | undefined {
  return response.headers
    .get('content-security-policy')
    ?.split('; ')
    .find((directive) => directive.startsWith(`${name} `))
}

function getDirectiveTokens(response: Response, name: string): string[] {
  return getDirective(response, name)?.split(' ').slice(1) ?? []
}

describe('middleware', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('does not redirect protected routes when auth mode is none', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'none')
    vi.stubEnv('NODE_ENV', 'development')
    const { middleware } = await importMiddleware()

    const response = middleware(new NextRequest('http://localhost:3002/'))
    const connectSrc = getDirectiveTokens(response, 'connect-src')

    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'self' 'nonce-",
    )
    expect(response.headers.get('x-nonce')).toBeTruthy()
    expect(connectSrc).toEqual([
      "'self'",
      'ws://localhost:3002',
      'ws://localhost:8003',
    ])
  })

  it('redirects protected routes to login when password auth has no session cookie', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'password')
    const { middleware } = await importMiddleware()

    const response = middleware(new NextRequest('http://localhost:3002/notes'))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3002/login?next=%2Fnotes',
    )
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'self' 'nonce-",
    )
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
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'self' 'nonce-",
    )
    expect(response.headers.get('x-nonce')).toBeTruthy()
  })

  it('adds only explicit companion origins to connect-src', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'none')
    vi.stubEnv('NEXT_PUBLIC_AGENT_HUB_URL', 'https://agent-hub.example.com')
    const { middleware } = await importMiddleware()

    const response = middleware(
      new NextRequest('https://a-term.summitflow.dev/'),
    )
    const connectSrc = getDirectiveTokens(response, 'connect-src')

    expect(connectSrc).toContain("'self'")
    expect(connectSrc).toContain('wss://a-term.summitflow.dev:8003')
    expect(connectSrc).toContain('https://agent-hub.example.com')
    expect(connectSrc).toContain('wss://agent-hub.example.com')
    expect(connectSrc).not.toContain('http:')
    expect(connectSrc).not.toContain('https:')
    expect(connectSrc).not.toContain('ws:')
    expect(connectSrc).not.toContain('wss:')
  })
})
