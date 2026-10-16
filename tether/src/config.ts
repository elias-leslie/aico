import { homedir } from 'node:os'
import { join } from 'node:path'

/** Tether's own API contract version. Clients declare the minimum they need. */
export const API_VERSION = 1

/** The one instance that serves Aico's legacy sockets and adopts historical servers. */
export const DEFAULT_INSTANCE = 'default'

const INSTANCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Linux `sun_path` holds 108 bytes including the terminating NUL. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 107
/** Aico allocates 16 random bytes per tmux server generation. */
const GENERATION_HEX_LENGTH = 32

export interface TetherPaths {
  instance: string
  /** True only for `default`: legacy sockets, historical adoption, `aico-*` unit names. */
  legacy: boolean
  stateDir: string
  dbPath: string
  /** Parent of `<id>/server.sock` for each private tmux server generation. */
  tmuxDir: string
  runtimeDir: string
  /** 0700 directory holding the control socket. */
  socketDir: string
  socket: string
  /** Directory the generation-specific tmux `pane-exited` hook touches. */
  paneExitMarkerDir: string
  /** Aico's legacy headless owner socket (`/v1/sessions/<widgetId>[/end]`). Default only. */
  legacyControlSocket: string | null
  /** Shim for Aico's GUI control socket (`/v1/roots`, `/v1/widgets`). Default only. */
  legacyGuiSocket: string | null
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
  // scripts and A-Term discovery keep working. Other instances never touch it.
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
    legacyControlSocket: legacy
      ? assertSocketPath(join(userRuntime, 'aico', 'control.sock'), 'legacy control')
      : null,
    legacyGuiSocket: legacy
      ? assertSocketPath(join(userRuntime, 'aico', 'gui-control.sock'), 'legacy GUI')
      : null,
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
