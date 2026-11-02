// The web server's settings: the environment first, then the repo's
// project.identity.json (port, public host), then defaults that hold by
// definition. Nothing here names a machine.

import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultTetherSocketPath, tetherSocketPath } from 'tether/client'
import { DEFAULT_REMOTE_UPLOAD_DIR } from 'tether/term'
import type { RouteName, VisionConfig } from './vision-extract'

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
  /** web/frontend's static export, served at `/`. */
  staticDir: string
  dbPath: string
  /** Durable data (`notes.db`, `blobs/`): the folder `web.db` lives in unless AICO_DATA_DIR says otherwise. */
  dataDir: string
  /** This host's name on rows it writes (`origin`): AICO_HOST_NAME, else the machine's. */
  hostName: string
  captures: CaptureConfig
  notes: NotesConfig
  vision: VisionSettings
  /** The capture type table's override file (the default table ships with Aico). */
  captureTypesFile: string
  portfolio: PortfolioSettings
  /** The Python backend's database, read once into `dbPath` and never written. */
  tetherSocket: string
  /** Agent shares are taken only from this user's tether@default (the owner's own socket). */
  trustShows: boolean
  agentHubUrl: string | null
  agentHubClientId: string | null
  /** Agent Hub's port on the page's host: the browser's voice socket without a configured URL. */
  agentHubPort: number
  /** Nightshift's web server on loopback, read for the Health panel; null: no panel data. */
  nightshiftUrl: string | null
  uploads: UploadConfig
  maintenance: MaintenanceConfig
}

export interface UploadConfig {
  dir: string
  /** Where a file for a session on another host is stored, on that host (`~/` is its home). */
  remoteDir: string
  maxBytes: number
  /** Uploads older than this are deleted by maintenance. */
  maxAgeMs: number
}

export interface CaptureConfig {
  /** Largest single capture file. */
  maxBytes: number
  /** Most files in one batch or ask. */
  maxFiles: number
}

export interface NotesConfig {
  /** Least time between two kept revisions of one title or body (`AICO_NOTE_REVISION_MINUTES`). */
  revisionWindowMs: number
}

/** Where receipts go: portfolio-ai's API, reached on loopback (the workstation's forwarder). */
export interface PortfolioSettings {
  /** Empty: receipts are not handed off. */
  url: string | null
  /** A file holding portfolio-ai's agent token; never read into config or logs. */
  tokenFile: string | null
  /** portfolio-ai's web address, to link a filed capture to its capture page. */
  appUrl: string | null
}

/** How captures are read (vision-extract) and how many are read at once. */
export interface VisionSettings extends VisionConfig {
  concurrency: number
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
  runtime?: { backend_port?: unknown }
  hosts?: { browser_frontend?: unknown }
  artifacts?: { upload_dir_name?: unknown }
}

// The Python backend's settings names and defaults, so its EnvironmentFile keeps
// working; only the upload dir name is Aico's own.
const DEFAULT_CAPTURE_MAX_MB = 25
const DEFAULT_CAPTURE_MAX_FILES = 20
/** Least time between two kept revisions of one note field while it is being edited. */
export const DEFAULT_NOTE_REVISION_MINUTES = 5
const DEFAULT_UPLOAD_DIR_NAME = 'aico-uploads'
const DEFAULT_MAX_UPLOAD_MB = 10
const DEFAULT_UPLOAD_MAX_AGE_SECONDS = 24 * 60 * 60
const DEFAULT_MAINTENANCE_INTERVAL_SECONDS = 15 * 60
const DEFAULT_EMPTY_PANE_DAYS = 7
// The browser's own fallback (web/frontend lib/api-config.ts PORTS.agentHub).
const DEFAULT_AGENT_HUB_PORT = 8003
// vision-extract (bake-off 2026-11-02): agy with a Gemini Flash model first, a
// local ollama vision model as the fallback.
const DEFAULT_VISION_ROUTES: RouteName[] = ['agy', 'ollama']
const DEFAULT_AGY_MODEL = 'gemini-3.8-flash-low'
const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
const DEFAULT_OLLAMA_MODEL = 'qwen3-vl:8b-instruct'
const DEFAULT_VISION_CONCURRENCY = 2
// The workstation's socket-activated forwarder to portfolio-ai on VM 180
// (portfolio-prod-api.socket); AICO_PORTFOLIO_URL=off turns hand-off off.
const DEFAULT_PORTFOLIO_URL = 'http://127.0.0.1:18000'
// Nightshift's own loopback address (its project.identity.json hosts.local_frontend).
const DEFAULT_NIGHTSHIFT_URL = 'http://127.0.0.1:3020'

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

/** AICO_VISION_ROUTES (comma list of agy, ollama), else both in that order. */
function visionRoutes(value: string | undefined): RouteName[] {
  const names = (list(value) ?? []).map((name) => name.toLowerCase())
  const known = names.filter((name): name is RouteName => name === 'agy' || name === 'ollama')
  return known.length ? known : DEFAULT_VISION_ROUTES
}

/** AICO_AGY_PATH, else ~/.local/bin/agy when it exists (the service's PATH may not have it), else `agy`. */
function agyPath(env: NodeJS.ProcessEnv, home: string): string {
  const set = env.AICO_AGY_PATH?.trim()
  if (set) return expandHome(set, home)
  const installed = join(home, '.local', 'bin', 'agy')
  return existsSync(installed) ? installed : 'agy'
}

/** AICO_NIGHTSHIFT_URL, `off` for none; Nightshift's own address otherwise. */
function nightshiftUrl(value: string | undefined): string | null {
  const text = value?.trim()
  if (!text) return DEFAULT_NIGHTSHIFT_URL
  return text.toLowerCase() === 'off' ? null : text
}

/** A setting that is a URL or `off`. */
function urlOrOff(value: string | undefined, fallback: string | null): string | null {
  const text = value?.trim()
  if (!text) return fallback
  return text.toLowerCase() === 'off' ? null : text
}

/** `~/.local/state/aico/web.db` unless `AICO_WEB_DB` says otherwise. */
export function webDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AICO_WEB_DB || join(stateDir(env), 'aico', 'web.db')
}

/** `AICO_DATA_DIR`, else the folder `web.db` is in. */
export function dataDirPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AICO_DATA_DIR?.trim() || dirname(webDbPath(env)))
}

function stateDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
}

// src/ and dist/ both sit in web/server, so the export is two levels up either way.
const HERE = dirname(fileURLToPath(import.meta.url))

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  identityFile: string | null = findIdentityFile(HERE),
): WebConfig {
  const identity = readIdentity(env.AICO_IDENTITY_FILE || identityFile)
  // The web app's port: the backend port, which Caddy and the tunnel point at.
  const port = parsePort(env.AICO_WEB_PORT) ?? parsePort(identity.runtime?.backend_port)
  if (port === null) throw new Error('No port: set AICO_WEB_PORT or runtime.backend_port')
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
    staticDir: resolve(env.AICO_WEB_STATIC_DIR || join(HERE, '..', '..', 'frontend', 'out')),
    dbPath: webDbPath(env),
    dataDir: dataDirPath(env),
    hostName: env.AICO_HOST_NAME?.trim().toLowerCase() || hostname().toLowerCase(),
    captures: {
      maxBytes: positiveInt(env.AICO_CAPTURE_MAX_MB, DEFAULT_CAPTURE_MAX_MB) * 1024 * 1024,
      maxFiles: positiveInt(env.AICO_CAPTURE_MAX_FILES, DEFAULT_CAPTURE_MAX_FILES),
    },
    notes: {
      revisionWindowMs:
        positiveInt(env.AICO_NOTE_REVISION_MINUTES, DEFAULT_NOTE_REVISION_MINUTES) * 60_000,
    },
    vision: {
      routes: visionRoutes(env.AICO_VISION_ROUTES),
      agyPath: agyPath(env, home),
      agyModel: env.AICO_AGY_MODEL?.trim() || DEFAULT_AGY_MODEL,
      ollamaUrl: env.AICO_OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL,
      ollamaModel: env.AICO_OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL,
      concurrency: positiveInt(env.AICO_VISION_CONCURRENCY, DEFAULT_VISION_CONCURRENCY),
    },
    captureTypesFile: resolve(
      expandHome(env.AICO_CAPTURE_TYPES_FILE?.trim() || '~/.config/aico/capture-types.json', home),
    ),
    portfolio: {
      url: urlOrOff(env.AICO_PORTFOLIO_URL, DEFAULT_PORTFOLIO_URL),
      tokenFile:
        env.AICO_PORTFOLIO_TOKEN_FILE?.trim() || env.HOUSEHOLD_AGENT_TOKEN_FILE?.trim() || null,
      appUrl: urlOrOff(env.AICO_PORTFOLIO_APP_URL, null),
    },
    tetherSocket,
    trustShows: tetherSocket === defaultTetherSocketPath(env, uid),
    agentHubUrl: env.AGENT_HUB_URL?.trim() || env.NEXT_PUBLIC_AGENT_HUB_URL?.trim() || null,
    agentHubClientId: env.AGENT_HUB_CLIENT_ID?.trim() || null,
    agentHubPort: DEFAULT_AGENT_HUB_PORT,
    nightshiftUrl: nightshiftUrl(env.AICO_NIGHTSHIFT_URL),
    uploads: {
      dir: resolve(expandHome(env.UPLOAD_DIR?.trim() || join(home, uploadDirName), home)),
      remoteDir: env.AICO_REMOTE_UPLOAD_DIR?.trim() || DEFAULT_REMOTE_UPLOAD_DIR,
      maxBytes: positiveInt(env.MAX_FILE_SIZE_MB, DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024,
      maxAgeMs: positiveInt(env.UPLOAD_MAX_AGE_SECONDS, DEFAULT_UPLOAD_MAX_AGE_SECONDS) * 1000,
    },
    maintenance: {
      enabled: flag(env.MAINTENANCE_ENABLED, true),
      intervalMs:
        positiveInt(env.MAINTENANCE_INTERVAL_SECONDS, DEFAULT_MAINTENANCE_INTERVAL_SECONDS) * 1000,
      emptyPaneDays: positiveInt(env.MAINTENANCE_SESSION_PURGE_DAYS, DEFAULT_EMPTY_PANE_DAYS),
    },
  }
}
