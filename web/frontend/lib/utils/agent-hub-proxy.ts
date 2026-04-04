'use client'

const AGENT_HUB_PROXY_BASE = '/api/agent-hub'

export function isAgentHubConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_AGENT_HUB_URL)
}

export function getAgentHubProxyUrl(path: 'models' | 'complete'): string | null {
  if (!isAgentHubConfigured()) {
    return null
  }

  return `${AGENT_HUB_PROXY_BASE}/${path}`
}
