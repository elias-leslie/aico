import { homedir } from 'node:os'
import { join } from 'node:path'

/** Tether's own API contract version. Clients declare the minimum they need.
 * 2: resize claims carry a viewer label (still accepted without one).
 * 3: session wakes; End takes `keepWakes`.
 * 4: shares link files where they are (`paths`); GET /v1/shares lists them.
 * 5, 6: chat routes and a chat `inject` model (retired with the Agent Hub chat backend).
 * 9: `parentId` on descriptors; root `lineage` takes `parentId`.
 * 10: `host: "auto"` with `needs` on `POST /v1/roots`; `GET /v1/placement`.
 * 12: lane reports: descriptors carry `stateAgentAt`, `waitingOn` and `launched`;
 *     `/v1/sessions/:id/watches`; wake lists show check-ins only.
 * 13: general waits (`/v1/waits`, `/v1/sessions/:id/waits`); `inject` takes
 *     `from`; End answers `keptWaits`.
 * 14: placement `room: "local"` hosts; `needs` with a named `host`.
 * 15: `entry` on `POST /v1/roots` (per-session entries.json program).
 * 16: deliveries (`POST /v1/sessions/:id/deliveries`, `GET /v1/deliveries/:id`,
 *     `GET /v1/sessions/:id/due`).
 * 17: wait kinds job, reply, run, ask, host and tap; `POST /v1/waits/check`
 *     (nudge); asks carry `answerTo`.
 * 18: wait kind `cmd` (`argv`, `cwd`); `DELETE /v1/sessions/:id/deliveries?source=`
 *     (withdraw); agy sessions take event lines.
 * 19: `entry` runs `codex` roots too (state from the entry home's rollouts).
 * 20: `entry` runs `pi` roots too (the conversation id Tether chose, read from
 *     the entry home's Pi session file).
 * 21: `endedBy` on `POST /v1/sessions/:id/end` (that session gets no lane
 *     `ended` line for it).
 * 22: `modelSwitch` on the session descriptor; `POST /v1/sessions/:id/rewind`.
 * 23: the hub takes a forwarded End's asker in the `Tether-Ended-By` header
 *     (a session on another host: no lane `ended` line for it).
 * 24: delivery classes: `ride` and `from` on `POST /v1/sessions/:id/deliveries`,
 *     `GET /v1/sessions/:id/due?ride=1`.
 * 25: `reply` on `POST /v1/sessions/:id/deliveries`; `GET /v1/sessions/:id/due?ride=peek`
 *     and `DELETE /v1/sessions/:id/due?token=` (take ride-along lines once shown).
 * 26: asks that want files: `files` on `POST /v1/asks`, `files` on an answer,
 *     `wantsFiles` and `files` on the ask (schema 30).
 * 27: `GET /v1/history`, `/v1/history/:id`, `/v1/history/:id/events` (schema 31).
 * 31: `open` and `origin` on `POST /v1/asks` and on the ask: the https link it opens, and who
 *     filed it when an app did (schema 35).
 * 32: `attach` on `POST /v1/asks` (paths linked as a share), `attached` on the ask: those
 *     files as they are on disk now.
 *
 * A bump also changes EXPECTED_TETHER_API_VERSION in packages/tether-client (config.test.ts keeps
 * them equal): a deploy restarts Tether when its code changed, and the web server names a daemon
 * older than that. */
export const API_VERSION = 32

/** Where Aico's web server listens on this host (`AICO_WEB_URL` overrides it). */
export const AICO_WEB_DEFAULT_URL = 'http://127.0.0.1:3002'

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

/** How much of an entry home's `.codex/sessions` one state read looks at
 * (continuity.ts `entryCodexRollout`). One agent runs per home, so a few
 * rollouts is the norm; these bound a home that holds very many. */
export interface EntryScanConfig {
  /** Rollout files listed per read (TETHER_ENTRY_ROLLOUT_SCAN). */
  rolloutScan: number
  /** Of those, the newest opened to find the user thread (TETHER_ENTRY_ROLLOUT_OPEN). */
  rolloutOpen: number
}

export const ENTRY_SCAN_DEFAULTS: EntryScanConfig = { rolloutScan: 2000, rolloutOpen: 32 }

export function resolveEntryScanConfig(env: NodeJS.ProcessEnv = process.env): EntryScanConfig {
  const read = (name: string, fallback: number) => {
    const raw = env[name]
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw) || Number(raw) < 1)
      throw new Error(`${name} must be a whole number, at least 1`)
    return Number(raw)
  }
  return {
    rolloutScan: read('TETHER_ENTRY_ROLLOUT_SCAN', ENTRY_SCAN_DEFAULTS.rolloutScan),
    rolloutOpen: read('TETHER_ENTRY_ROLLOUT_OPEN', ENTRY_SCAN_DEFAULTS.rolloutOpen),
  }
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
function assertSocketPath(path: string, label: string): string {
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
