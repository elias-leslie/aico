import { homedir } from 'node:os'
import { join } from 'node:path'

/** Tether's own API contract version. Clients declare the minimum they need.
 * 2: resize claims carry a viewer label (still accepted without one).
 * 3: session wakes; End takes `keepWakes`.
 * 4: shares link files where they are (`paths`); GET /v1/shares lists them.
 * 5: Agent Hub chat routes (`/chat`, `/chat/stream`, `/chat/cancel`, `/v1/chat/models`).
 * 6: an Agent Hub session's `inject` takes `model` (a catalog model for that turn; null for the agent's own routing). */
export const API_VERSION = 6

/** The one instance that keeps Aico's names and adopts historical servers. */
export const DEFAULT_INSTANCE = 'default'

export interface ShowConfig {
  /** Shares older than this are dropped when the next one arrives. */
  retentionDays: number
}

export function resolveShowConfig(env: NodeJS.ProcessEnv = process.env): ShowConfig {
  const raw = env.TETHER_SHARE_RETENTION_DAYS
  const retentionDays = raw === undefined ? 30 : Number(raw)
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !(retentionDays >= 1)) {
    throw new Error('TETHER_SHARE_RETENTION_DAYS must be a whole number of days, at least 1')
  }
  return { retentionDays }
}

const INSTANCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Linux `sun_path` holds 108 bytes including the terminating NUL. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 107
/** Aico allocates 16 random bytes per tmux server generation. */
const GENERATION_HEX_LENGTH = 32

export interface TetherPaths {
  instance: string
  /** True only for `default`: Aico's runtime layout, historical adoption, `aico-*` unit names. */
  legacy: boolean
  stateDir: string
  dbPath: string
  /** Parent of `<id>/server.sock` for each private tmux server generation. */
  tmuxDir: string
  runtimeDir: string
  /** Directory holding the control socket (0700). */
  socketDir: string
  socket: string
  /** Directory the generation-specific tmux `pane-exited` hook touches. */
  paneExitMarkerDir: string
  /** Historical shared tmux socket, adopted read-only. Default only. */
  historicalTmuxSocket: string | null
  /** Optional local project list for the fallback provider. */
  localProjectsFile: string
  configDir: string
}

export function isInstanceName(value: string): boolean {
  return INSTANCE_RE.test(value)
}

export function assertInstanceName(value: string): string {
  if (!isInstanceName(value)) {
    throw new Error(
      `invalid Tether instance name ${JSON.stringify(value)}: use 1-32 of a-z, 0-9, '-', starting alphanumeric`,
    )
  }
  return value
}

function effectiveUid(uid: number | undefined): number {
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('Tether requires a numeric Unix uid')
  }
  return uid
}

/** Reject relative, traversal, NUL and overlong socket paths before binding. */
export function assertSocketPath(path: string, label: string): string {
  if (
    !path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..')) ||
    Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new Error(`invalid ${label} socket path: ${path}`)
  }
  return path
}

export interface ResolveOptions {
  instance?: string
  env?: NodeJS.ProcessEnv
  uid?: number
  home?: string
}

/**
 * Every filesystem location an instance owns. Overrides (`TETHER_STATE_DIR`,
 * `TETHER_SOCKET`, `TETHER_RUNTIME_DIR`) exist for tests and isolated
 * verification; production units set none of them.
 */
export function resolvePaths(options: ResolveOptions = {}): TetherPaths {
  const env = options.env ?? process.env
  const instance = assertInstanceName(options.instance ?? env.TETHER_INSTANCE ?? DEFAULT_INSTANCE)
  const uid = effectiveUid(options.uid ?? process.getuid?.())
  const home = options.home ?? env.HOME ?? homedir()
  const legacy = instance === DEFAULT_INSTANCE

  const stateRoot = env.XDG_STATE_HOME || join(home, '.local', 'state')
  const stateDir = env.TETHER_STATE_DIR || join(stateRoot, 'tether', instance)
  const configRoot = env.XDG_CONFIG_HOME || join(home, '.config')
  const configDir = join(configRoot, 'tether')
  const userRuntime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`
  const runtimeDir = env.TETHER_RUNTIME_DIR || join(userRuntime, 'tether', instance)
  const socket = assertSocketPath(env.TETHER_SOCKET || join(runtimeDir, 'control.sock'), 'control')
  const socketDir = socket.slice(0, socket.lastIndexOf('/')) || '/'

  // The default instance keeps Aico's exact runtime layout so existing hooks,
  // scripts and the web app's discovery keep working. Other instances never touch it.
  const aicoRuntime = `/run/user/${uid}/aico`
  const paneExitMarkerDir = legacy ? aicoRuntime : join(runtimeDir, 'pane-exits')

  const tmuxDir = join(stateDir, 'tmux')
  const longest = join(tmuxDir, 'f'.repeat(GENERATION_HEX_LENGTH), 'server.sock')
  assertSocketPath(longest, 'tmux server')

  return {
    instance,
    legacy,
    stateDir,
    dbPath: join(stateDir, 'tether.db'),
    tmuxDir,
    runtimeDir,
    socketDir,
    socket,
    paneExitMarkerDir,
    historicalTmuxSocket: legacy ? `/tmp/tmux-${uid}/aico` : null,
    localProjectsFile: join(configDir, 'projects.json'),
    configDir,
  }
}

const GENERATION_RE = /^[0-9a-f]{8,64}$/

/**
 * Transient systemd unit for one private tmux server generation. The default
 * instance keeps Aico's exact name so historical rows stay valid evidence;
 * other instances embed their name and never match another instance's units.
 */
export function tmuxServerUnit(instance: string, serverId: string): string {
  assertInstanceName(instance)
  if (!GENERATION_RE.test(serverId))
    throw new Error(`unsafe tmux server generation id: ${serverId}`)
  return instance === DEFAULT_INSTANCE
    ? `aico-tmux-server-${serverId}.service`
    : `tether-${instance}-tmux-server-${serverId}.service`
}

/** Units this instance may reconcile. Never matches another instance's units. */
export function ownsTmuxServerUnit(instance: string, unit: string): boolean {
  assertInstanceName(instance)
  const match =
    instance === DEFAULT_INSTANCE
      ? /^aico-tmux-server-([0-9a-f]{8,64})\.(?:scope|service)$/.exec(unit)
      : new RegExp(`^tether-${instance}-tmux-server-([0-9a-f]{8,64})\\.service$`).exec(unit)
  return match !== null
}

export function tmuxServerSocketPath(paths: TetherPaths, serverId: string): string {
  if (!GENERATION_RE.test(serverId))
    throw new Error(`unsafe tmux server generation id: ${serverId}`)
  return assertSocketPath(join(paths.tmuxDir, serverId, 'server.sock'), 'tmux server')
}

export function paneExitMarkerPath(paths: TetherPaths, serverId: string): string {
  if (!GENERATION_RE.test(serverId))
    throw new Error(`unsafe tmux server generation id: ${serverId}`)
  return join(paths.paneExitMarkerDir, `pane-exited-${serverId}`)
}

/** Directory the pane supervisor writes each agent's fate to, one file per
 * pane scope (src/lifecycle/tui/launch.ts paneCommand). Inside the instance's
 * runtime directory, so a reboot clears it. */
export function agentExitMarkerDir(paths: Pick<TetherPaths, 'runtimeDir'>): string {
  return join(paths.runtimeDir, 'agent-exits')
}
