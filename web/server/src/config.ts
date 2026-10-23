// The web server's settings: the environment first, then the repo's
// project.identity.json (port, public host), then defaults that hold by
// definition. Nothing here names a machine.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tetherSocketPath } from 'tether/client'

export interface WebConfig {
  /** Loopback only: the app has no login of its own (Access gates the edge). */
  host: string
  port: number
  /** The public host name (identity `hosts.browser_frontend`), or null. */
  publicHost: string | null
  /** Host names (any port) the server answers; anything else is refused. */
  allowedHostnames: string[]
  /** Browser origins allowed to open the terminal WebSocket and to change state. */
  allowedOrigins: string[]
  dbPath: string
  /** The Python backend's database, read once into `dbPath` and never written. */
  importDbPath: string
  tetherSocket: string
  agentHubUrl: string | null
  agentHubClientId: string | null
}

/** History lines each seed carries; the browser sizes its scrollback from it. */
export const HISTORY_LINES = 20_000

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

interface Identity {
  runtime?: { frontend_port?: unknown }
  hosts?: { browser_frontend?: unknown }
}

/** The nearest project.identity.json above `from` (the repo root's). */
export function findIdentityFile(from: string): string | null {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, 'project.identity.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readIdentity(path: string | null): Identity {
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Identity
  } catch {
    return {}
  }
}

function parsePort(value: unknown): number | null {
  const port = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : null
}

function list(value: string | undefined): string[] | null {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? items : null
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  identityFile: string | null = findIdentityFile(dirname(fileURLToPath(import.meta.url))),
): WebConfig {
  const identity = readIdentity(env.AICO_IDENTITY_FILE || identityFile)
  // The web app's port: today's frontend port, which Caddy and the tunnel point at.
  const port = parsePort(env.AICO_WEB_PORT) ?? parsePort(identity.runtime?.frontend_port)
  if (port === null) throw new Error('No port: set AICO_WEB_PORT or runtime.frontend_port')
  const host = env.AICO_WEB_HOST?.trim() || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host.toLowerCase()))
    throw new Error(`The web server binds loopback only (got ${host})`)
  const publicHost =
    typeof identity.hosts?.browser_frontend === 'string' && identity.hosts.browser_frontend
      ? identity.hosts.browser_frontend.toLowerCase()
      : null
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
  return {
    host,
    port,
    publicHost,
    allowedHostnames: ['localhost', '127.0.0.1', ...(publicHost ? [publicHost] : [])],
    allowedOrigins: list(env.AICO_WEB_ALLOWED_ORIGINS) ?? [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...(publicHost ? [`https://${publicHost}`] : []),
    ],
    dbPath: env.AICO_WEB_DB || join(state, 'aico', 'web.db'),
    importDbPath: env.AICO_WEB_IMPORT_DB || join(state, 'a-term', 'a-term.db'),
    tetherSocket: tetherSocketPath(env, process.getuid?.()),
    agentHubUrl: env.AGENT_HUB_URL?.trim() || env.NEXT_PUBLIC_AGENT_HUB_URL?.trim() || null,
    agentHubClientId: env.AGENT_HUB_CLIENT_ID?.trim() || null,
  }
}
