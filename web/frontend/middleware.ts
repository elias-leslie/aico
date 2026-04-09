import { NextResponse, type NextRequest } from 'next/server'
import { buildContentSecurityPolicy, createCspNonce } from '@/lib/security/csp'

const AUTH_COOKIE_NAME = process.env.A_TERM_AUTH_COOKIE_NAME || 'a_term_session'
const AUTH_MODE = process.env.A_TERM_AUTH_MODE || 'none'

function isProtectedPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/notes'
}

function applySecurityHeaders(response: NextResponse, nonce: string, csp: string): NextResponse {
  response.headers.set('Content-Security-Policy', csp)
  response.headers.set('x-nonce', nonce)
  return response
}

export function middleware(request: NextRequest) {
  const nonce = createCspNonce()
  const csp = buildContentSecurityPolicy({ nonce })
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
    return applySecurityHeaders(NextResponse.redirect(new URL(target, request.url)), nonce, csp)
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

export const config = {
  matcher: ['/', '/notes', '/login'],
}
