// The one place Tether builds an Agent Hub client: the shared TypeScript SDK
// (@agent-hub/sdk), with the owner token read from its file per request so a
// rotated token is picked up and the value lives nowhere else.

import { readFileSync } from 'node:fs'
import { createClient, OWNER_TOKEN_HEADER } from '@agent-hub/sdk'
import type { AgentHubConfig } from './config'
import type { HubApi } from './runtime'

export function createHubApi(
  config: AgentHubConfig,
  readToken: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): HubApi {
  return createClient({
    baseUrl: config.baseUrl,
    ...(config.clientId ? { clientId: config.clientId } : {}),
    requestSource: config.requestSource,
    headers: (): Record<string, string> => {
      if (!config.ownerTokenFile) return {}
      try {
        const token = readToken(config.ownerTokenFile).trim()
        return token ? { [OWNER_TOKEN_HEADER]: token } : {}
      } catch {
        return {}
      }
    },
  })
}
