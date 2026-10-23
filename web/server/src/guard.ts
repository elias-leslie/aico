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

import type { IncomingHttpHeaders, ServerResponse } from 'node:http'

const HOST_PATTERN = /^([a-z0-9.-]+)(:[0-9]{1,5})?$/
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export type Refusal = 'host_not_allowed' | 'origin_not_allowed'

export interface GuardConfig {
  allowedHostnames: readonly string[]
  allowedOrigins: readonly string[]
}

export function hostAllowed(host: string | undefined, config: GuardConfig): boolean {
  const match = HOST_PATTERN.exec((host ?? '').toLowerCase())
  return match !== null && config.allowedHostnames.includes(match[1])
}

function foreignOrigin(origin: string | undefined, config: GuardConfig): boolean {
  return origin !== undefined && !config.allowedOrigins.includes(origin)
}

/** Why an HTTP request is refused, or null. */
export function checkRequest(
  method: string,
  headers: IncomingHttpHeaders,
  config: GuardConfig,
): Refusal | null {
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

/** API answers are data, never a page: nothing in them may load or frame. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'"

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
}
