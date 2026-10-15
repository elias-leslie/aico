import { type NextRequest, NextResponse } from 'next/server'
import { PRODUCT_PUBLIC_HOST } from '@/lib/project-branding'
import { buildContentSecurityPolicy, createCspNonce } from '@/lib/security/csp'

const AUTH_COOKIE_NAME = process.env.A_TERM_AUTH_COOKIE_NAME || 'a_term_session'
const AUTH_MODE = process.env.A_TERM_AUTH_MODE || 'none'

// Host names this server answers (any port). The /api and /ws rewrites reach the backend with a loopback Host, so
// a DNS-rebinding page (Host evil.example:3002) must be stopped here, before the rewrite.
const ALLOWED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  PRODUCT_PUBLIC_HOST,
])
const HOST_PATTERN = /^([a-z0-9.-]+)(:[0-9]{1,5})?$/

export function isAllowedHost(host: string | null): boolean {
  const match = HOST_PATTERN.exec((host ?? '').toLowerCase())
  return match !== null && ALLOWED_HOSTNAMES.has(match[1])
}

function isPagePath(pathname: string): boolean {
  return pathname === '/' || pathname === '/login'
}

function isProtectedPath(pathname: string): boolean {
  return pathname === '/'
}

function applySecurityHeaders(
  response: NextResponse,
  nonce: string,
  csp: string,
): NextResponse {
  response.headers.set('Content-Security-Policy', csp)
  response.headers.set('x-nonce', nonce)
  return response
}

export function proxy(request: NextRequest) {
  if (!isAllowedHost(request.headers.get('host'))) {
    return NextResponse.json({ error: 'host_not_allowed' }, { status: 403 })
  }
  if (!isPagePath(request.nextUrl.pathname)) {
    return NextResponse.next()
  }

  const nonce = createCspNonce()
  const csp = buildContentSecurityPolicy({ nonce, requestUrl: request.url })
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)

  if (AUTH_MODE === 'none') {
    return applySecurityHeaders(
      NextResponse.next({
        request: {
          headers: requestHeaders,
        },
      }),
      nonce,
      csp,
    )
  }

  const { pathname, search } = request.nextUrl
  const hasSessionCookie = request.cookies.has(AUTH_COOKIE_NAME)

  if (pathname === '/login') {
    if (!hasSessionCookie) {
      return applySecurityHeaders(
        NextResponse.next({
          request: {
            headers: requestHeaders,
          },
        }),
        nonce,
        csp,
      )
    }

    const next = request.nextUrl.searchParams.get('next')
    const target = next?.startsWith('/') ? next : '/'
    return applySecurityHeaders(
      NextResponse.redirect(new URL(target, request.url)),
      nonce,
      csp,
    )
  }

  if (!isProtectedPath(pathname) || hasSessionCookie) {
    return applySecurityHeaders(
      NextResponse.next({
        request: {
          headers: requestHeaders,
        },
      }),
      nonce,
      csp,
    )
  }

  const loginUrl = new URL('/login', request.url)
  loginUrl.searchParams.set('next', `${pathname}${search}`)
  return applySecurityHeaders(NextResponse.redirect(loginUrl), nonce, csp)
}

// No matcher: the Host check covers every path, including the /api and /ws rewrites and static assets.
