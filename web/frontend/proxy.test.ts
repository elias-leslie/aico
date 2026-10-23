import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function importProxy() {
  vi.resetModules()
  return import('./proxy')
}

// A browser request: the Host header matches the URL (Next derives nextUrl from its own bind address, not Host).
function browserRequest(
  url: string,
  init: { headers?: Record<string, string> } = {},
) {
  return new NextRequest(url, {
    headers: { host: new URL(url).host, ...init.headers },
  })
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

describe('proxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('does not redirect protected routes when auth mode is none', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'none')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AGENT_HUB_URL', '')
    const { proxy } = await importProxy()

    const response = proxy(browserRequest('http://localhost:3002/'))
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
    const { proxy } = await importProxy()

    const response = proxy(
      browserRequest('http://localhost:3002/?project=a-term'),
    )

    expect(response.headers.get('location')).toBe(
      'http://localhost:3002/login?next=%2F%3Fproject%3Da-term',
    )
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'self' 'nonce-",
    )
  })

  it('allows protected routes when password auth has the session cookie', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'password')
    const { proxy } = await importProxy()

    const response = proxy(
      browserRequest('http://localhost:3002/', {
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

  it.each([
    ['%2F%3Fproject%3Da-term', 'http://localhost:3002/?project=a-term'],
    ['%2F%2Fevil.example', 'http://localhost:3002/'],
    ['%2F%5Cevil.example', 'http://localhost:3002/'],
    ['https%3A%2F%2Fevil.example%2F', 'http://localhost:3002/'],
    ['%2F.%2F%2Fevil.example', 'http://localhost:3002/'],
    ['%2Fa%2F..%2F%2Fevil.example', 'http://localhost:3002/'],
  ])(
    'sends a signed-in /login?next=%s only to a same-origin path',
    async (next, location) => {
      vi.stubEnv('A_TERM_AUTH_MODE', 'password')
      const { proxy } = await importProxy()

      const response = proxy(
        browserRequest(`http://localhost:3002/login?next=${next}`, {
          headers: { cookie: 'a_term_session=present' },
        }),
      )

      expect(response.headers.get('location')).toBe(location)
    },
  )

  it('adds only explicit companion origins to connect-src', async () => {
    vi.stubEnv('A_TERM_AUTH_MODE', 'none')
    vi.stubEnv('NEXT_PUBLIC_AGENT_HUB_URL', 'https://agent-hub.example.com')
    const { proxy } = await importProxy()

    const response = proxy(browserRequest('https://aico.summitflow.dev/'))
    const connectSrc = getDirectiveTokens(response, 'connect-src')

    expect(connectSrc).toContain("'self'")
    expect(connectSrc).toContain('wss://aico.summitflow.dev:8003')
    expect(connectSrc).toContain('https://agent-hub.example.com')
    expect(connectSrc).toContain('wss://agent-hub.example.com')
    expect(connectSrc).not.toContain('http:')
    expect(connectSrc).not.toContain('https:')
    expect(connectSrc).not.toContain('ws:')
    expect(connectSrc).not.toContain('wss:')
  })

  describe('Host check', () => {
    it.each([
      'evil.example:3002',
      'evil.example',
      '192.168.86.128:3002',
      'localhost.evil.example:3002',
      '127.0.0.1.evil.example',
      'aico.summitflow.dev.evil.example',
      'evil.example@127.0.0.1:3002',
      '127.0.0.1:3002@evil.example',
      '[::1]:3002',
      '',
    ])(
      'refuses Host %j on pages, the /api and /ws rewrites and assets',
      async (host) => {
        vi.stubEnv('A_TERM_AUTH_MODE', 'none')
        const { proxy } = await importProxy()

        for (const path of [
          '/',
          '/login',
          '/api/a-term/panes',
          '/ws/a-term/s1',
          '/_next/static/x.js',
        ]) {
          const response = proxy(
            new NextRequest(`http://127.0.0.1:3002${path}`, {
              headers: { host },
            }),
          )
          expect(response.status).toBe(403)
          expect(await response.json()).toEqual({ error: 'host_not_allowed' })
        }
      },
    )

    it('refuses a request with no Host header', async () => {
      const { proxy } = await importProxy()
      expect(
        proxy(new NextRequest('http://127.0.0.1:3002/api/a-term/panes')).status,
      ).toBe(403)
    })

    it.each([
      'localhost:3002',
      '127.0.0.1:3002',
      'LOCALHOST:3002',
      'aico.summitflow.dev',
      'aico.summitflow.dev:443',
    ])(
      'lets Host %j through to the rewrites without page headers',
      async (host) => {
        vi.stubEnv('A_TERM_AUTH_MODE', 'none')
        const { proxy } = await importProxy()

        const response = proxy(
          new NextRequest('http://127.0.0.1:3002/api/a-term/panes', {
            headers: { host, 'x-forwarded-host': 'evil.example' },
          }),
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('x-middleware-next')).toBe('1')
        expect(response.headers.get('content-security-policy')).toBeNull()
      },
    )

    it('ignores X-Forwarded-Host when Host is foreign', async () => {
      const { proxy } = await importProxy()
      const response = proxy(
        new NextRequest('http://127.0.0.1:3002/', {
          headers: {
            host: 'evil.example',
            'x-forwarded-host': 'localhost:3002',
          },
        }),
      )
      expect(response.status).toBe(403)
    })
  })
})
