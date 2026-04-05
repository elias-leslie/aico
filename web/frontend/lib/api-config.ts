/**
 * API configuration for A-Term frontend.
 *
 * Uses same-origin routing via Next.js rewrites to avoid CORS issues with CF Access:
 * - Development: http://localhost:3002/api/* -> localhost:8002/api/* (rewrite)
 * - Production: https://aterm.summitflow.dev/api/* -> localhost:8002/api/* (rewrite)
 *
 * This pattern ensures all API requests go through the same origin as the frontend,
 * with Next.js server-side proxying to the backend. No cross-origin = no CORS.
 */

import { PRODUCT_PORTS } from './project-branding'

export const PORTS = {
  frontend: PRODUCT_PORTS.frontend,
  backend: PRODUCT_PORTS.backend,
  summitflow: 8001,
  agentHub: 8003,
} as const

function getServerApiOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_ATERM_API_URL ||
    process.env.API_URL ||
    `http://localhost:${PORTS.backend}`
  )
}

/**
 * Get the base URL for A-Term backend API calls.
 *
 * Returns empty string for client-side (same-origin via rewrites) or localhost for server-side.
 *
 * @returns Base URL (empty for client-side same-origin, full URL for server-side)
 */
export function getApiBaseUrl(): string {
  // Server-side: use API_URL from the active deployment/runtime or localhost fallback
  if (typeof window === 'undefined') {
    return getServerApiOrigin()
  }

  // Client-side: use same-origin paths (Next.js rewrites handle proxying)
  // All requests go to /api/* on current origin, rewrites proxy to backend
  return ''
}

/**
 * Get WebSocket URL for a given path.
 *
 * Automatically handles ws/wss based on current protocol.
 *
 * IMPORTANT: In production, WebSocket uses same-origin routing via Cloudflare Tunnel
 * path-based rules. This avoids CF Access cookie issues (cookies are subdomain-specific).
 * The Tunnel config routes /ws/* paths directly to the backend.
 *
 * @param path - WebSocket path (e.g., /ws/aterm/session-id)
 * @returns Full WebSocket URL
 */
export function getWsUrl(path: string): string {
  if (typeof window === 'undefined') {
    const apiUrl = getServerApiOrigin()
    return apiUrl.replace(/^http/, 'ws') + path
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = window.location.hostname
  const originHost = window.location.host

  // Development
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `ws://localhost:${PORTS.backend}${path}`
  }

  // Non-local browser hosts must use same-origin /ws routing.
  // This covers production plus emulator/device access such as 10.0.2.2:3002.
  return `${protocol}//${originHost}${path}`
}

/**
 * Build a full API URL from a path.
 *
 * @param path - API path (e.g., /api/aterm/sessions)
 * @returns Full URL
 */
export function buildApiUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`
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
  return `${protocol}//${baseUrl.host}/api/voice/ws?user_id=aterm&app=aterm`
}
