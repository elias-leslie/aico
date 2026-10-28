// Where Agent Hub is and who Tether is when it calls it. Read in this trusted
// process only: nothing here reaches a session, a log line or an API answer.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AgentHubConfig {
  baseUrl: string
  /** The registered client id (`X-Client-Id`); Agent Hub refuses turns without one. */
  clientId: string | null
  /** Which app is calling (`X-Request-Source`). */
  requestSource: string
  /** File holding the owner token; its contents are read per request. */
  ownerTokenFile: string | null
}

export const DEFAULT_AGENT_HUB_URL = 'http://localhost:8003'
export const DEFAULT_REQUEST_SOURCE = 'aico-tether'

/** `KEY=value` lines of an env file (`export` prefix and quotes allowed). */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]))
      value = value.slice(1, -1)
    values[line.slice(0, eq).trim()] = value
  }
  return values
}

function readEnvLocal(home: string, read: (path: string) => string): Record<string, string> {
  try {
    return parseEnvFile(read(join(home, '.env.local')))
  } catch {
    return {}
  }
}

/**
 * `TETHER_AGENT_HUB_URL`, `TETHER_AGENT_HUB_CLIENT_ID`,
 * `TETHER_AGENT_HUB_REQUEST_SOURCE` and `TETHER_AGENT_HUB_OWNER_TOKEN_FILE`
 * win; the client id and token file fall back to the owner's `~/.env.local`
 * (`SUMMITFLOW_CLIENT_ID`, `AGENT_HUB_OWNER_TOKEN_FILE`), where every Agent
 * Hub client already finds them.
 */
export function resolveAgentHubConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? homedir(),
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): AgentHubConfig {
  const local = readEnvLocal(home, read)
  const pick = (...values: (string | undefined)[]) => values.find((v) => v) ?? null
  return {
    baseUrl: pick(env.TETHER_AGENT_HUB_URL, local.AGENT_HUB_URL) ?? DEFAULT_AGENT_HUB_URL,
    clientId: pick(env.TETHER_AGENT_HUB_CLIENT_ID, local.SUMMITFLOW_CLIENT_ID),
    requestSource: pick(env.TETHER_AGENT_HUB_REQUEST_SOURCE) ?? DEFAULT_REQUEST_SOURCE,
    ownerTokenFile: pick(env.TETHER_AGENT_HUB_OWNER_TOKEN_FILE, local.AGENT_HUB_OWNER_TOKEN_FILE),
  }
}
