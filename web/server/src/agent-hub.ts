// The same-origin Agent Hub proxy (the Next route's port): the browser asks
// /api/agent-hub/models and this server forwards it with the app's client id,
// so the id never reaches the page. Upstream failures answer a safe detail.

import type { ServerResponse } from 'node:http'
import { sendJson } from './http'

export interface AgentHubConfig {
  agentHubUrl: string | null
  agentHubClientId: string | null
}

/** Paths the proxy forwards: the browser's path below /api/agent-hub to Agent Hub's. */
export const AGENT_HUB_PATHS: Readonly<Record<string, string>> = {
  models: '/api/models',
}

function safeDetail(status: number): string {
  if (status === 400 || status === 422) return 'Agent Hub rejected the request'
  if (status === 401 || status === 403) return 'Agent Hub denied the request'
  if (status === 404) return 'Agent Hub endpoint is unavailable'
  if (status >= 500) return 'Agent Hub is temporarily unavailable'
  return 'Agent Hub request failed'
}

export async function proxyAgentHub(
  config: AgentHubConfig,
  upstreamPath: string,
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!config.agentHubUrl) {
    sendJson(res, 503, { detail: 'Agent Hub is not configured' })
    return
  }
  const headers: Record<string, string> = { 'X-Request-Source': 'a-term' }
  if (config.agentHubClientId) headers['X-Client-Id'] = config.agentHubClientId
  try {
    const upstream = await fetchImpl(`${config.agentHubUrl.replace(/\/+$/, '')}${upstreamPath}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (!upstream.ok) {
      console.error(`[aico-web] Agent Hub ${upstreamPath} answered ${upstream.status}`)
      sendJson(res, upstream.status, { detail: safeDetail(upstream.status) })
      return
    }
    const body = await upstream.text()
    res.statusCode = upstream.status
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(body)
  } catch (error) {
    console.error(`[aico-web] Agent Hub ${upstreamPath} unreachable:`, (error as Error).message)
    sendJson(res, 502, { detail: 'Failed to reach Agent Hub' })
  }
}
