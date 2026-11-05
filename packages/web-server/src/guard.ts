// Who gets in. The app has no login of its own: Cloudflare Access gates the
// public host at the edge and Caddy serves it locally, so every request that
// reaches this loopback server is the owner's -- unless a page on another site
// (or a DNS-rebinding page) is making the owner's browser send it. Two checks
// stop that, for HTTP and the WebSocket alike:
//
// - Host: only loopback names and the public host (any port). A rebinding
//   page reaches the socket with its own host name and is refused first.
// - Origin: a WebSocket, or a POST/PUT/PATCH/DELETE, from a page whose Origin
//   is not in the configured list (`null` included) is refused. Callers that
//   send no Origin (CLI, agents, curl) are unaffected.
// - Phone hosts: a second public name (the one the phone app already reaches, through the
//   tunnel's /api/app/ rule) is answered for the phone app's routes only. Its Access gate is a
//   service token that opens nothing else, so any other path, and any WebSocket, is refused here.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

const HOST_PATTERN = /^([a-z0-9.-]+)(:[0-9]{1,5})?$/
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export type Refusal = 'host_not_allowed' | 'origin_not_allowed'

export interface GuardConfig {
  allowedHostnames: readonly string[]
  allowedOrigins: readonly string[]
  /** Names that reach only the phone app's routes (`/api/app/...`, strictly written), not the owner's pages or API. */
  phoneHosts?: readonly string[]
  /** Named on every response as `X-Aico-Host`, so the service worker can tell this server from a proxy's error page. */
  hostName?: string
}

export function hostAllowed(host: string | undefined, config: GuardConfig): boolean {
  const match = HOST_PATTERN.exec((host ?? '').toLowerCase())
  return match !== null && config.allowedHostnames.includes(match[1])
}

function foreignOrigin(origin: string | undefined, config: GuardConfig): boolean {
  return origin !== undefined && !config.allowedOrigins.includes(origin)
}

function hostIn(host: string | undefined, names: readonly string[] | undefined): boolean {
  const match = HOST_PATTERN.exec((host ?? '').toLowerCase())
  return match !== null && (names ?? []).includes(match[1])
}

/**
 * The only request targets a phone host serves, read from the raw request line (before any URL
 * parser tidies it): `/api/app/` and plain path characters, an optional query. No dot segments
 * (also percent-encoded), no empty segments, no backslash, no encoded slash.
 */
const PHONE_TARGET = /^\/api\/app\/[A-Za-z0-9_~%-][A-Za-z0-9._~%/-]*(\?[A-Za-z0-9._~%=&-]*)?$/
export function phoneTargetAllowed(target: string | undefined): boolean {
  if (!target || !PHONE_TARGET.test(target)) return false
  const path = target.split('?')[0]
  if (/%(2e|2f|5c|00)/i.test(path) || path.includes('//')) return false
  return !path.split('/').some((segment) => segment === '.' || segment === '..')
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost'])
/** Set by a proxy in front of this server (Caddy, cloudflared): the request came from elsewhere. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip']

/**
 * Whether a program on this machine sent the request straight to the loopback port: a loopback
 * peer, a loopback Host, no proxy's forwarding headers and no browser Origin. The public host
 * reaches this server through Caddy on loopback too, so the peer address alone is not enough.
 */
export function fromThisMachine(req: IncomingMessage): boolean {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) return false
  const host = HOST_PATTERN.exec((req.headers.host ?? '').toLowerCase())
  if (!host || !LOOPBACK_NAMES.has(host[1] as string)) return false
  if (req.headers.origin !== undefined) return false
  return !FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined)
}

/** Why an HTTP request is refused, or null. */
export function checkRequest(
  method: string,
  headers: IncomingHttpHeaders,
  config: GuardConfig,
  target?: string,
): Refusal | null {
  if (hostIn(headers.host, config.phoneHosts))
    return (phoneTargetAllowed(target) ||
      (method === 'POST' && /^\/hooks\/canary\/[A-Za-z0-9_-]{32,128}$/.test(target ?? ''))) &&
      !(UNSAFE_METHODS.has(method) && foreignOrigin(headers.origin, config))
      ? null
      : 'host_not_allowed'
  if (!hostAllowed(headers.host, config)) return 'host_not_allowed'
  if (UNSAFE_METHODS.has(method) && foreignOrigin(headers.origin, config))
    return 'origin_not_allowed'
  return null
}

/** Why a WebSocket upgrade is refused, or null. */
export function checkUpgrade(headers: IncomingHttpHeaders, config: GuardConfig): Refusal | null {
  if (!hostAllowed(headers.host, config)) return 'host_not_allowed'
  if (foreignOrigin(headers.origin, config)) return 'origin_not_allowed'
  return null
}

/** Headers every response carries (proxy.ts, next.config.ts and the Python app's, merged). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

/** Names the answering host. A response without it did not come from aico-web (Cloudflare's own error page, say). */
export const HOST_HEADER = 'X-Aico-Host'

/** API answers are data, never a page: nothing in them may load or frame. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'"

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
}
