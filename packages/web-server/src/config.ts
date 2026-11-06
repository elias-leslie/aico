// The web server's settings: the environment first, then the repo's
// project.identity.json (port, public host), then defaults that hold by
// definition. Nothing here names a machine.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RouteName, VisionConfig } from '@aico/notes/vision-extract'
import { defaultTetherSocketPath, hostsFile, tetherSocketPath } from '@aico/tether-client'
import { DEFAULT_REMOTE_UPLOAD_DIR } from '@aico/tether-client/term'
import type { AccessConfig } from './access'
import type { PairingConfig } from './app-pairing'
import type { ExportConfig } from './notes-export'

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
  /** Public names that reach only the phone app's routes (the host the installed phone app already uses). */
  phoneHosts: string[]
  /** The Access gate tunnel-forwarded requests must have passed (identity `access`); null refuses them all. */
  access: AccessConfig | null
  pairing: PairingConfig
  /** packages/web-frontend's static export, served at `/`. */
  staticDir: string
  dbPath: string
  /** Durable data (`notes.db`, `blobs/`): the folder `web.db` lives in unless AICO_DATA_DIR says otherwise. */
  dataDir: string
  /** This host's name on rows it writes (`origin`): AICO_HOST_NAME, else the machine's. */
  hostName: string
  /** A fingerprint of this server bundle (`AICO_BUILD_ID` overrides); two hosts on the same build share it. */
  buildId: string
  captures: CaptureConfig
  notes: NotesConfig
  /** The nightly Drive copy of the notes (`AICO_EXPORT_*`). */
  export: ExportConfig
  /**
   * How often aico-web reports its own Status rows (`AICO_STATUS_HEARTBEAT_SECONDS`), and how long
   * the same rows turning the same way again stay off the phone (`AICO_STATUS_ALERT_COOLDOWN_SECONDS`).
   */
  status: { heartbeatMs: number; alertCooldownS: number }
  /**
   * The Projects page: how often Proxmox is read for each place's power state
   * (`AICO_PROJECTS_POLL_SECONDS`), how long a start, shutdown or restart is shown as going
   * (`AICO_PROJECTS_BUSY_SECONDS`), how long a project's last commit time is reused
   * (`AICO_PROJECTS_ACTIVITY_SECONDS`) and the Proxmox call's timeout (`AICO_PROJECTS_PVE_TIMEOUT_SECONDS`).
   */
  projects: { pollMs: number; busyMs: number; activityMs: number; pveTimeoutMs: number }
  /** Owner notices (notify.ts): the phone push files, the outbox pace, the OmniNull hub's door. */
  serviceApps: { listen: { host: string; port: number } | null }
  notify: NotifyConfig
  sync: SyncConfig
  vision: VisionSettings
  /** The capture type table's override file (the default table ships with Aico). */
  captureTypesFile: string
  portfolio: PortfolioSettings
  /** The Python backend's database, read once into `dbPath` and never written. */
  tetherSocket: string
  /** Agent shares are taken only from this user's tether@default (the owner's own socket). */
  trustShows: boolean
  uploads: UploadConfig
  maintenance: MaintenanceConfig
}

export interface NotifyConfig {
  /** The FCM access token Nightshift's root timer mints (ns-20); read to send, never logged. */
  fcmTokenFile: string
  /** The paired phones: FCM token, push keys and signing key per phone. Aico's own file (the phone app's API writes it). */
  devicesFile: string
  /** Nightshift's phone file: copied to `devicesFile` once, when that does not exist yet, so the phone keeps its pairing. */
  devicesSeedFile?: string
  /** How often the outbox looks for due sends and writes its Status row. */
  passMs: number
  ominull: {
    /** The keys the hub may send as X-API-Key, as sha256 hashes: `{"keys": [{"name", "sha256"}]}`. */
    keysFile: string
    /** A private LAN address (`host:port`) where the hub's pushes are also taken; null: loopback only. */
    listen: { host: string; port: number } | null
    /** The Nightshift site file whose `ominull` ingest source names the hub's URL and CA. */
    siteFile: string
    /** The key the hub's verdict route takes (0600, yours); read to send, never logged. */
    relayKeyFile: string
  }
}

const PRIVATE_V4 = /^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/

/** `host:port` on a private IPv4 address, else null (the hub's door is never on a public address). */
export function privateListen(value: string | undefined): { host: string; port: number } | null {
  const match = /^([\d.]+):(\d{1,5})$/.exec(value?.trim() ?? '')
  if (!match || !PRIVATE_V4.test(match[1] as string)) return null
  const port = Number(match[2])
  return port > 0 && port < 65536 ? { host: match[1] as string, port } : null
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

/** This host's name on rows it writes: AICO_HOST_NAME, else the machine's. */
export function hostNameFrom(env: NodeJS.ProcessEnv): string {
  return env.AICO_HOST_NAME?.trim().toLowerCase() || hostname().toLowerCase()
}

/** Names the running build: AICO_BUILD_ID, else the first 12 hex of the SHA-256 of this server bundle. */
function buildIdFrom(env: NodeJS.ProcessEnv): string {
  const set = env.AICO_BUILD_ID?.trim()
  if (set) return set
  try {
    return createHash('sha256')
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex')
      .slice(0, 12)
  } catch {
    return 'unknown'
  }
}

export interface NotesConfig {
  /** Least time between two kept revisions of one title or body (`AICO_NOTE_REVISION_MINUTES`). */
  revisionWindowMs: number
}

export interface SyncConfig {
  /** How long a delete is remembered for peers (`AICO_SYNC_TOMBSTONE_DAYS`). */
  tombstoneMs: number
  /** A batch with a stamp further ahead than this is refused (`AICO_SYNC_MAX_AHEAD_HOURS`). */
  maxAheadMs: number
  /** The sync listener's unix socket (`AICO_SYNC_SOCKET`), else `$XDG_RUNTIME_DIR/aico/sync.sock`. */
  socket: string
  /** Pull each peer this often, and on a nudge (`AICO_SYNC_INTERVAL_SECONDS`). */
  intervalMs: number
  /** How often a local write is looked for, to nudge the peers (`AICO_SYNC_WATCH_MS`). */
  watchMs: number
  /** A peer that says nothing for this long on an open request is dropped (`AICO_SYNC_IDLE_SECONDS`). */
  idleMs: number
  /** A blob nothing references is removed once its file is this old (`AICO_SYNC_BLOB_GRACE_DAYS`). */
  blobGraceMs: number
  /** hosts.json, read for the peers that have a `sync` socket. */
  hostsFile: string
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
  access?: { team_domain?: unknown; audiences?: unknown }
}

/** The identity's `access` block: the Access team domain and each public host's audience tag. */
function accessFrom(identity: Identity): AccessConfig | null {
  const team = identity.access?.team_domain
  const audiences = identity.access?.audiences
  if (typeof team !== 'string' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) return null
  if (!audiences || typeof audiences !== 'object' || Array.isArray(audiences)) return null
  const tags: Record<string, string> = {}
  for (const [host, tag] of Object.entries(audiences))
    if (typeof tag === 'string' && /^[0-9a-f]{64}$/.test(tag)) tags[host.toLowerCase()] = tag
  return { teamDomain: team, audiences: tags }
}

// The Python backend's settings names and defaults, so its EnvironmentFile keeps
// working; only the upload dir name is Aico's own.
/** The host the installed phone app already uses (moves to Aico's own name when its Access gate does). */
const DEFAULT_PHONE_HOST = 'nightshift.summitflow.dev'
const DEFAULT_CAPTURE_MAX_MB = 25
const DEFAULT_CAPTURE_MAX_FILES = 20
/** Least time between two kept revisions of one note field while it is being edited. */
export const DEFAULT_NOTE_REVISION_MINUTES = 5
const DEFAULT_TOMBSTONE_DAYS = 180
export const DEFAULT_MAX_AHEAD_HOURS = 24
const DEFAULT_SYNC_INTERVAL_SECONDS = 60
const DEFAULT_SYNC_IDLE_SECONDS = 30
const DEFAULT_SYNC_WATCH_MS = 1000
const DEFAULT_BLOB_GRACE_DAYS = 7
// The nightly export: the remote and folder names scripts/authorize-notes-drive.sh and the Drive copy agree on.
const DEFAULT_EXPORT_REMOTE = 'aico-notes-drive'
const DEFAULT_EXPORT_FOLDER = 'SummitFlow-Notes'
const DEFAULT_STATUS_HEARTBEAT_SECONDS = 5 * 60
const DEFAULT_PROJECTS_POLL_SECONDS = 30
const DEFAULT_PROJECTS_BUSY_SECONDS = 10 * 60
const DEFAULT_PROJECTS_ACTIVITY_SECONDS = 30
const DEFAULT_PROJECTS_PVE_TIMEOUT_SECONDS = 15
// A row that flaps pushes at most this often for the same change (notify's per-key cooldown).
const DEFAULT_STATUS_ALERT_COOLDOWN_SECONDS = 6 * 60 * 60
// Where Nightshift keeps the phone push files today. The FCM access token is still minted there; the paired
// phones are copied once into Aico's data directory (phones.json), so the phone keeps its pairing.
const DEFAULT_FCM_TOKEN_FILE = '/var/lib/nightshift/fcm/token.json'
const DEFAULT_NOTIFY_PASS_SECONDS = 30
const DEFAULT_OMINULL_SITE = '/etc/nightshift/site.json'
const DEFAULT_UPLOAD_DIR_NAME = 'aico-uploads'
const DEFAULT_MAX_UPLOAD_MB = 10
const DEFAULT_UPLOAD_MAX_AGE_SECONDS = 24 * 60 * 60
const DEFAULT_MAINTENANCE_INTERVAL_SECONDS = 15 * 60
const DEFAULT_EMPTY_PANE_DAYS = 7
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

/** The nearest project.identity.json above `from` (the repo root's). */
function findIdentityFile(from: string): string | null {
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

/** The installed app's action links survive re-pairing during the Nightshift cutover. */
function phoneOrigins(env: NodeJS.ProcessEnv, publicHost: string | null): string[] {
  const explicit = list(env.AICO_APP_OPEN_ORIGINS) ?? list(env.NIGHTSHIFT_OPEN_ORIGINS)
  if (explicit) return explicit
  const origins = publicHost ? [`https://${publicHost}`] : []
  try {
    const site = JSON.parse(
      readFileSync(env.NIGHTSHIFT_SITE || '/etc/nightshift/site.json', 'utf8'),
    )
    const hosts = [
      site.urls?.approve_host,
      ...(Array.isArray(site.urls?.open_hosts) ? site.urls.open_hosts : []),
    ]
    for (const host of hosts)
      if (typeof host === 'string' && /^[a-z0-9.-]+$/i.test(host)) origins.push(`https://${host}`)
  } catch {}
  return [...new Set(origins)]
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

// src/ and dist/ both sit in packages/web-server, so the export is two levels up either way.
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
    phoneHosts: (list(env.AICO_PHONE_HOSTS) ?? [DEFAULT_PHONE_HOST]).map((h) => h.toLowerCase()),
    access: accessFrom(identity),
    pairing: {
      base:
        env.AICO_APP_BASE || `https://${(list(env.AICO_PHONE_HOSTS) ?? [DEFAULT_PHONE_HOST])[0]}`,
      origins: phoneOrigins(env, publicHost),
      gateFile: env.AICO_APP_GATE_FILE || join(dataDirPath(env), 'app-gate.json'),
      optionsFile: env.AICO_APP_OPTIONS_FILE || '/etc/nightshift/fcm-app.json',
      codesFile: join(dataDirPath(env), 'app-pair.json'),
      ttlSeconds: positiveInt(env.AICO_APP_PAIR_TTL_SECONDS, 600),
    },
    allowedOrigins: list(env.AICO_WEB_ALLOWED_ORIGINS) ?? [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...(publicHost ? [`https://${publicHost}`] : []),
    ],
    staticDir: resolve(env.AICO_WEB_STATIC_DIR || join(HERE, '..', '..', 'web-frontend', 'out')),
    dbPath: webDbPath(env),
    dataDir: dataDirPath(env),
    hostName: hostNameFrom(env),
    buildId: buildIdFrom(env),
    captures: {
      maxBytes: positiveInt(env.AICO_CAPTURE_MAX_MB, DEFAULT_CAPTURE_MAX_MB) * 1024 * 1024,
      maxFiles: positiveInt(env.AICO_CAPTURE_MAX_FILES, DEFAULT_CAPTURE_MAX_FILES),
    },
    notes: {
      revisionWindowMs:
        positiveInt(env.AICO_NOTE_REVISION_MINUTES, DEFAULT_NOTE_REVISION_MINUTES) * 60_000,
    },
    export: {
      stagingDir: join(dataDirPath(env), 'export'),
      rcloneConfig: resolve(
        expandHome(
          env.AICO_EXPORT_RCLONE_CONFIG?.trim() || '~/.config/aico-export/notes-drive.conf',
          home,
        ),
      ),
      rclonePath: env.AICO_EXPORT_RCLONE?.trim() || 'rclone',
      remote: env.AICO_EXPORT_REMOTE?.trim() || DEFAULT_EXPORT_REMOTE,
      folder: env.AICO_EXPORT_FOLDER?.trim() || DEFAULT_EXPORT_FOLDER,
      deferTo: env.AICO_EXPORT_DEFER_TO?.trim() || null,
    },
    status: {
      heartbeatMs:
        positiveInt(env.AICO_STATUS_HEARTBEAT_SECONDS, DEFAULT_STATUS_HEARTBEAT_SECONDS) * 1000,
      alertCooldownS: Math.min(
        positiveInt(env.AICO_STATUS_ALERT_COOLDOWN_SECONDS, DEFAULT_STATUS_ALERT_COOLDOWN_SECONDS),
        7 * 24 * 60 * 60,
      ),
    },
    projects: {
      pollMs: positiveInt(env.AICO_PROJECTS_POLL_SECONDS, DEFAULT_PROJECTS_POLL_SECONDS) * 1000,
      busyMs: positiveInt(env.AICO_PROJECTS_BUSY_SECONDS, DEFAULT_PROJECTS_BUSY_SECONDS) * 1000,
      activityMs:
        positiveInt(env.AICO_PROJECTS_ACTIVITY_SECONDS, DEFAULT_PROJECTS_ACTIVITY_SECONDS) * 1000,
      pveTimeoutMs:
        positiveInt(env.AICO_PROJECTS_PVE_TIMEOUT_SECONDS, DEFAULT_PROJECTS_PVE_TIMEOUT_SECONDS) *
        1000,
    },
    serviceApps: { listen: privateListen(env.AICO_SERVICE_APPS_LISTEN) },
    notify: {
      fcmTokenFile: env.AICO_FCM_TOKEN_FILE?.trim() || DEFAULT_FCM_TOKEN_FILE,
      devicesFile: env.AICO_PHONE_DEVICES_FILE?.trim() || join(dataDirPath(env), 'phones.json'),
      devicesSeedFile: env.AICO_PHONE_DEVICES_SEED?.trim() || undefined,
      passMs: positiveInt(env.AICO_NOTIFY_PASS_SECONDS, DEFAULT_NOTIFY_PASS_SECONDS) * 1000,
      ominull: {
        keysFile: resolve(
          expandHome(env.AICO_OMINULL_KEYS?.trim() || '~/.config/aico/ominull-keys.json', home),
        ),
        listen: privateListen(env.AICO_OMINULL_LISTEN),
        siteFile: env.AICO_OMINULL_SITE?.trim() || DEFAULT_OMINULL_SITE,
        relayKeyFile: resolve(
          expandHome(
            env.AICO_OMINULL_RELAY_KEY?.trim() || '~/.config/nightshift/ominull-relay.key',
            home,
          ),
        ),
      },
    },
    sync: {
      tombstoneMs: positiveInt(env.AICO_SYNC_TOMBSTONE_DAYS, DEFAULT_TOMBSTONE_DAYS) * 86_400_000,
      maxAheadMs: positiveInt(env.AICO_SYNC_MAX_AHEAD_HOURS, DEFAULT_MAX_AHEAD_HOURS) * 3_600_000,
      socket: resolve(
        env.AICO_SYNC_SOCKET?.trim() ||
          join(env.XDG_RUNTIME_DIR || `/run/user/${uid ?? 0}`, 'aico', 'sync.sock'),
      ),
      intervalMs: positiveInt(env.AICO_SYNC_INTERVAL_SECONDS, DEFAULT_SYNC_INTERVAL_SECONDS) * 1000,
      watchMs: positiveInt(env.AICO_SYNC_WATCH_MS, DEFAULT_SYNC_WATCH_MS),
      idleMs: positiveInt(env.AICO_SYNC_IDLE_SECONDS, DEFAULT_SYNC_IDLE_SECONDS) * 1000,
      blobGraceMs: positiveInt(env.AICO_SYNC_BLOB_GRACE_DAYS, DEFAULT_BLOB_GRACE_DAYS) * 86_400_000,
      hostsFile: hostsFile(env, home),
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
