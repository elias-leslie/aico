/**
 * API configuration for the web app.
 *
 * The page, /api/* and /ws/* share one origin: web/server serves all three,
 * behind Cloudflare Access at the edge and Caddy locally. Same origin keeps
 * the Access cookie on every request and needs no CORS.
 */

/**
 * Get WebSocket URL for a given path on this page's origin (ws/wss to match).
 *
 * @param path - WebSocket path (e.g., /ws/session-id)
 * @returns Full WebSocket URL
 */
export function getWsUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${path}`
}
