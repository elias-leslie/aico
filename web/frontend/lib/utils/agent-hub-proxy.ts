'use client'

const AGENT_HUB_PROXY_BASE = '/api/agent-hub'

/** The same-origin proxy route. Whether Agent Hub is configured is the
 * server's runtime setting (AGENT_HUB_URL); the proxy answers 503 without it,
 * so a build made without the env file still finds Agent Hub once it is set. */
export function getAgentHubProxyUrl(path: 'models'): string {
  return `${AGENT_HUB_PROXY_BASE}/${path}`
}
