// The web server's settings: the environment first, then the repo's
// project.identity.json (port, public host), then defaults that hold by
// definition. Nothing here names a machine.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultTetherSocketPath, tetherSocketPath } from 'tether/client'

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
  /** Agent shares are taken only from this user's tether@default (the owner's own socket). */
  trustShows: boolean
  agentHubUrl: string | null
  agentHubClientId: string | null
  uploads: UploadConfig
  /** Where the default Tether copies shared files (`<root>/agent/…`); Tether's variable and default. */
  exchangeRoot: string
  maintenance: MaintenanceConfig
}

export interface UploadConfig {
  dir: string
  maxBytes: number
  /** Uploads older than this are deleted by maintenance. */
  maxAgeMs: number
}

export interface MaintenanceConfig {
  /** Off: maintenance runs once at startup only. */
  enabled: boolean
  intervalMs: number
  /** Tabs left showing no session are deleted after this many days. */
  emptyPaneDays: number
}

/** History lines each seed carries; the browser sizes its scrollback from it. */
export const HISTORY_LINES = 20_000

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

interface Identity {
  runtime?: { frontend_port?: unknown }
  hosts?: { browser_frontend?: unknown }
  artifacts?: { upload_dir_name?: unknown }
}

// The Python backend's settings names and defaults, so its EnvironmentFile keeps working.
const DEFAULT_UPLOAD_DIR_NAME = 'a-term-uploads'
const DEFAULT_MAX_UPLOAD_MB = 10
const DEFAULT_UPLOAD_MAX_AGE_SECONDS = 24 * 60 * 60
const DEFAULT_MAINTENANCE_INTERVAL_SECONDS = 15 * 60
const DEFAULT_EMPTY_PANE_DAYS = 7
const DEFAULT_EXCHANGE_ROOT = '/srv/workspaces/exchange'

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

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value?.trim() ? Number(value.trim()) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** pydantic's spelling of a boolean setting. */
function flag(value: string | undefined, fallback: boolean): boolean {
  const text = value?.trim().toLowerCase()
  if (!text) return fallback
  if (['1', 'true', 'yes', 'on', 't', 'y'].includes(text)) return true
  if (['0', 'false', 'no', 'off', 'f', 'n'].includes(text)) return false
  return fallback
}

function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
}

function list(value: string | undefined): string[] | null {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? items : null
}

/** `~/.local/state/aico/web.db` unless `AICO_WEB_DB` says otherwise. */
export function webDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AICO_WEB_DB || join(stateDir(env), 'aico', 'web.db')
}

function stateDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
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
  const home = env.HOME || homedir()
  const uploadDirName =
    typeof identity.artifacts?.upload_dir_name === 'string' && identity.artifacts.upload_dir_name
      ? identity.artifacts.upload_dir_name
      : DEFAULT_UPLOAD_DIR_NAME
  const exchangeRoot = env.TETHER_EXCHANGE_ROOT || DEFAULT_EXCHANGE_ROOT
  if (!isAbsolute(exchangeRoot) || exchangeRoot.includes('\0'))
    throw new Error('TETHER_EXCHANGE_ROOT must be an absolute path without NUL')
  const uid = process.getuid?.()
  const tetherSocket = tetherSocketPath(env, uid)
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
    dbPath: webDbPath(env),
    importDbPath: env.AICO_WEB_IMPORT_DB || join(stateDir(env), 'a-term', 'a-term.db'),
    tetherSocket,
    trustShows: tetherSocket === defaultTetherSocketPath(env, uid),
    agentHubUrl: env.AGENT_HUB_URL?.trim() || env.NEXT_PUBLIC_AGENT_HUB_URL?.trim() || null,
    agentHubClientId: env.AGENT_HUB_CLIENT_ID?.trim() || null,
    uploads: {
      dir: resolve(expandHome(env.UPLOAD_DIR?.trim() || join(home, uploadDirName), home)),
      maxBytes: positiveInt(env.MAX_FILE_SIZE_MB, DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024,
      maxAgeMs: positiveInt(env.UPLOAD_MAX_AGE_SECONDS, DEFAULT_UPLOAD_MAX_AGE_SECONDS) * 1000,
    },
    exchangeRoot,
    maintenance: {
      enabled: flag(env.MAINTENANCE_ENABLED, true),
      intervalMs:
        positiveInt(env.MAINTENANCE_INTERVAL_SECONDS, DEFAULT_MAINTENANCE_INTERVAL_SECONDS) * 1000,
      emptyPaneDays: positiveInt(env.MAINTENANCE_SESSION_PURGE_DAYS, DEFAULT_EMPTY_PANE_DAYS),
    },
  }
}
