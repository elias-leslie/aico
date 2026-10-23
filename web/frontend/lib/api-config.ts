/**
 * API configuration for the web app.
 *
 * The page, /api/* and /ws/* share one origin: web/server serves all three,
 * behind Cloudflare Access at the edge and Caddy locally. Same origin keeps
 * the Access cookie on every request and needs no CORS.
 */

export const PORTS = {
  agentHub: 8003,
} as const

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

export function getAgentHubVoiceWsUrl(): string {
  if (typeof window === 'undefined') return ''

  const configuredBaseUrl = process.env.NEXT_PUBLIC_AGENT_HUB_URL?.trim()
  const baseUrl = configuredBaseUrl
    ? new URL(configuredBaseUrl)
    : new URL(
        `${window.location.protocol}//${window.location.hostname}:${PORTS.agentHub}`,
      )

  const protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${baseUrl.host}/api/voice/ws?user_id=a-term&app=aTerm`
}
