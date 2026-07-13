// tmux session model. Pure helpers (no electron/node-pty imports) so they
// unit-test cheaply. Aico addresses its private server by an absolute socket
// path, never by tmux's ambient TMUX_TMPDIR-dependent label resolution.

const PRODUCTION_SOCKET_LABEL = 'aico'
const MAX_UNIX_SOCKET_PATH_BYTES = 107
const SAFE_SOCKET_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const SAFE_SOCKET_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/
const MANAGED_SERVER_GENERATION_ID = /^[0-9a-f]{8,64}$/
const PANE_EXITED_FILE_PREFIX = 'pane-exited-'

function effectiveUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) {
    throw new Error('Aico requires a numeric Unix uid to address its durable tmux socket')
  }
  return uid as number
}

/**
 * Resolve the internal server's socket to an absolute path. `-L aico`
 * historically resolves to `/tmp/tmux-<uid>/aico`; spelling that path out
 * preserves existing sessions while preventing an inherited TMUX_TMPDIR from
 * silently selecting or creating a different server.
 *
 * AICO_TMUX_SOCKET is a test/recovery override. A safe label remains rooted in
 * the historical per-user tmux directory, while an explicit absolute path is
 * accepted for an isolated test directory. Empty, relative-path, traversal,
 * control-character, and overlong values fail closed.
 */
export function resolveInternalTmuxSocket(
  override: string | undefined,
  uid: number = effectiveUid(),
): string {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`unsafe tmux uid: ${uid}`)
  const value = override === undefined ? PRODUCTION_SOCKET_LABEL : override
  if (value.length === 0) throw new Error('AICO_TMUX_SOCKET must not be empty')

  const socketPath = value.startsWith('/')
    ? value
    : `/tmp/tmux-${uid}/${validateSocketLabel(value)}`
  validateAbsoluteSocketPath(socketPath)
  return socketPath
}

function validateSocketLabel(label: string): string {
  if (!SAFE_SOCKET_LABEL.test(label)) throw new Error(`unsafe tmux socket label: ${label}`)
  return label
}

function validateAbsoluteSocketPath(socketPath: string): string {
  if (!socketPath.startsWith('/'))
    throw new Error(`tmux socket path must be absolute: ${socketPath}`)
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`tmux socket path is too long: ${socketPath}`)
  }
  const segments = socketPath.slice(1).split('/')
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !SAFE_SOCKET_PATH_SEGMENT.test(segment),
    )
  ) {
    throw new Error(`unsafe tmux socket path: ${socketPath}`)
  }
  return socketPath
}

/** Absolute path to Aico's durable internal tmux server. */
export const TMUX_SOCKET = resolveInternalTmuxSocket(process.env.AICO_TMUX_SOCKET)
// A-Term currently exposes attachable tmux sessions with this legacy prefix.
export const A_TERM_SESSION_PREFIX = 'summitflow-'

export interface TmuxTarget {
  socket: string | null
  session: string
}

export type TmuxEnvironment = Record<string, string>

export interface ScrollbackPageBounds {
  fromLine: number
  toLineExclusive: number
  totalLines: number
  startCoord: number
  endCoord: number
}

/** Only a reply from a reachable tmux server proving that the requested
 * durable session does not exist may authorize absence cleanup. Permission,
 * timeout, protocol, and socket transport failures remain unknown. */
export function isDefinitiveTmuxAbsence(stderr: string): boolean {
  return stderr.split(/\r?\n/).some((line) => /^\s*can't find session:\s*\S.*$/i.test(line))
}

/**
 * Classifies a missing/unreachable tmux transport for diagnostics and startup
 * bootstrap only. This is deliberately separate from definitive session
 * absence: callers must never use it as authority to retire persisted work.
 */
export function isTmuxTransportUnavailable(stderr: string): boolean {
  return (
    /error connecting to .+\(No such file or directory\)/i.test(stderr) ||
    /no server running on /i.test(stderr)
  )
}

export function internalTarget(widgetId: string): TmuxTarget {
  return { socket: TMUX_SOCKET, session: sessionName(widgetId) }
}

function socketArgs(socket: string | null): string[] {
  if (socket === null) return []
  if (socket.startsWith('/')) return ['-S', validateAbsoluteSocketPath(socket)]
  return ['-L', validateSocketLabel(socket)]
}

function targetArgs(target: TmuxTarget, args: string[]): string[] {
  return [...socketArgs(target.socket), ...args]
}

// High history so scrollback survives long sessions. The scrollback-gate
// subtask stresses this (10k+ lines); 100k gives generous headroom.
export const HISTORY_LIMIT = 100_000

/** Stable per-window session name. Reload re-attaches the same session. */
export function sessionName(widgetId: string): string {
  return `aico-${widgetId}`
}

/**
 * Contents of the tmux config passed via `-f`. tmux reads this once at server
 * start, so the high history-limit applies to every session created on the
 * socket. (Setting it via `set-option` only works once a server is running,
 * which is the race we hit otherwise.)
 *
 * tmux mouse mode is deliberately OFF — but NOT because xterm.js owns
 * scrollback (it can't: an attached tmux client drives xterm's alternate
 * screen, which has no scrollback). Scrollback lives in tmux history and the
 * renderer reads it on demand via `captureArgs` into a read-only overlay (see
 * electron/renderer/scrollback-overlay.ts). With mouse OFF, tmux never grabs
 * the wheel for its own copy-mode, so the renderer can drive that overlay, and
 * application mouse events (Claude Code's TUI) pass straight through.
 *
 * tmux's status bar is OFF too: Aico draws its own chrome (titlebar + frosted
 * border), so the green `[aico-1] 0:bash*` + clock row is redundant and just
 * eats a terminal row.
 */
export function tmuxConf(): string {
  return `${tmuxProfileLines().join('\n')}\n`
}

function tmuxProfileLines(): string[] {
  return [
    `set -g history-limit ${HISTORY_LIMIT}`,
    'set -g mouse off',
    'set -g status off',
    'set -g default-terminal "tmux-256color"',
    'set -g terminal-overrides ",xterm-256color:Tc"',
    'set -g terminal-features "xterm*:sync"',
    'set-environment -gu NO_COLOR',
    'set-environment -g COLORTERM truecolor',
    'set-environment -g CLICOLOR 1',
  ]
}

/**
 * Runtime updates for an already-running Aico tmux server, chained with tmux's
 * `;` command separator so one spawn applies the whole profile.
 */
export function tmuxProfileArgs(): string[] {
  return tmuxProfileTargetArgs(TMUX_SOCKET)
}

export function tmuxProfileTargetArgs(socket: string): string[] {
  const commands = [
    ['set-option', '-g', 'history-limit', String(HISTORY_LIMIT)],
    ['set-option', '-g', 'mouse', 'off'],
    ['set-option', '-g', 'status', 'off'],
    ['set-option', '-g', 'default-terminal', 'tmux-256color'],
    ['set-option', '-g', 'terminal-overrides', ',xterm-256color:Tc'],
    ['set-option', '-g', 'terminal-features', 'xterm*:sync'],
    ['set-environment', '-gu', 'NO_COLOR'],
    ['set-environment', '-g', 'COLORTERM', 'truecolor'],
    ['set-environment', '-g', 'CLICOLOR', '1'],
  ]
  return [
    ...socketArgs(socket),
    ...commands.flatMap((args, i) => (i === 0 ? args : [';', ...args])),
  ]
}

export function paneExitedEventPath(serverId: string, uid: number = effectiveUid()): string {
  if (!MANAGED_SERVER_GENERATION_ID.test(serverId)) {
    throw new Error(`invalid tmux server generation id: ${serverId}`)
  }
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`unsafe tmux uid: ${uid}`)
  return `/run/user/${uid}/aico/${PANE_EXITED_FILE_PREFIX}${serverId}`
}

/**
 * Install the one global event bridge used to reconcile panes that exit while
 * Electron is detached. The hook writes one durable generation-tagged marker
 * in the user's runtime directory. Aico watches it in-process and retains it as
 * level-triggered recovery evidence, so an app crash cannot lose the signal or
 * orphan a blocking tmux client.
 */
export function paneExitedHookTargetArgs(
  socket: string,
  serverId: string,
  uid: number = effectiveUid(),
): string[] {
  return [
    '-S',
    validateAbsoluteSocketPath(socket),
    'set-hook',
    '-g',
    'pane-exited',
    paneExitedHookCommand(serverId, uid),
  ]
}

export function paneExitedHookCommand(serverId: string, uid: number = effectiveUid()): string {
  // tmux canonicalizes the command list to a double-quoted run-shell argument;
  // generate that exact representation so the pre-dispatch live query can use
  // byte equality rather than an unsafe semantic shell parser.
  return `run-shell "/usr/bin/touch ${paneExitedEventPath(serverId, uid)}"`
}

/** Read the exact stored global hook value immediately before a launch leaves
 * its gate. Cached installation success is not enough because a later tmux
 * source-file or set-hook command can replace the cleanup bridge. */
export function showPaneExitedHookTargetArgs(socket: string): string[] {
  return ['-S', validateAbsoluteSocketPath(socket), 'show-options', '-gHqv', 'pane-exited']
}

/**
 * `tmux` argv that prints the session's entire scrollback to stdout with color
 * escapes preserved (`-e`), from the oldest line (`-S -`) to the current
 * bottom (`-E -`). The renderer feeds this into the read-only overlay xterm
 * when the user scrolls up.
 */
export function captureArgs(widgetId: string): string[] {
  return captureTargetArgs(internalTarget(widgetId))
}

export function captureTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, [
    'capture-pane',
    '-t',
    target.session,
    '-p', // print to stdout
    '-e', // include escape sequences (colors/attrs)
    '-S',
    '-', // start: oldest line in history
    '-E',
    '-', // end: current bottom
  ])
}

export function paneScrollbackInfoTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, [
    'display-message',
    '-p',
    '-t',
    target.session,
    '#{history_size} #{pane_height}',
  ])
}

export function scrollbackPageBounds(
  historySize: number,
  paneHeight: number,
  count: number,
  requestedFromLine?: number,
): ScrollbackPageBounds | null {
  const history = Math.max(0, Math.floor(historySize))
  const height = Math.max(0, Math.floor(paneHeight))
  const totalLines = history + height
  if (totalLines <= 0) return null

  const safeCount = Math.max(1, Math.floor(count))
  const fromLine =
    requestedFromLine === undefined
      ? Math.max(0, totalLines - safeCount)
      : Math.min(Math.max(0, Math.floor(requestedFromLine)), totalLines - 1)
  const toLineExclusive = Math.min(totalLines, fromLine + safeCount)

  return {
    fromLine,
    toLineExclusive,
    totalLines,
    startCoord: fromLine - history,
    endCoord: toLineExclusive - 1 - history,
  }
}

export function capturePageTargetArgs(target: TmuxTarget, bounds: ScrollbackPageBounds): string[] {
  return targetArgs(target, [
    'capture-pane',
    '-t',
    target.session,
    '-p',
    '-e',
    '-S',
    String(bounds.startCoord),
    '-E',
    String(bounds.endCoord),
  ])
}

/**
 * `tmux` argv that lists existing sessions for adoption, one per line as
 * "<session_name> <created_epoch_seconds>" so the catalog can preserve age order.
 */
export function listArgs(): string[] {
  return listServerSessionsArgs(TMUX_SOCKET)
}

function listServerSessionsArgs(socket: string): string[] {
  return [...socketArgs(socket), 'list-sessions', '-F', '#{session_name} #{session_created}']
}

/** One verified roster read carries the server PID on every row so callers can
 * reject a socket collision before interpreting session presence/absence. */
export function serverRosterArgs(socket: string): string[] {
  return [
    ...socketArgs(socket),
    'list-sessions',
    '-F',
    '#{pid}\t#{session_id}\t#{session_name}\t#{session_created}',
  ]
}

/** `tmux` argv that kills a widget's session (used by an explicit Discard). */
export function killArgs(widgetId: string): string[] {
  return killTargetArgs(internalTarget(widgetId))
}

export function killTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, ['kill-session', '-t', target.session])
}

/** Extract the widget id from an `aico-<id>` session name, or null. */
export function widgetIdFromSession(session: string): string | null {
  const m = /^aico-(.+)$/.exec(session)
  return m ? m[1] : null
}

/** A-Term managed sessions live on the default tmux server with this prefix. */
export function isATermSessionName(session: string): boolean {
  return new RegExp(`^${A_TERM_SESSION_PREFIX}[0-9a-f-]{36}$`).test(session)
}

/** `tmux` argv that tests whether a widget's session already exists (exit 0). */
export function hasSessionArgs(widgetId: string): string[] {
  return hasTargetArgs(internalTarget(widgetId))
}

export function hasTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, ['has-session', '-t', target.session])
}

/**
 * `tmux` argv that creates the widget's session detached, in `cwd`. Carries
 * `-f confPath` (the global flag that configures the server when it first
 * starts, applying the high history-limit). Creation is split from attach so
 * the TUI launch command runs exactly once, on first create — reattaching a
 * window must not relaunch a running agent. The pane starts in a fixed,
 * no-profile/no-RC gate shell; only after tmux finishes its per-pane cgroup
 * placement does Aico send the real interactive-shell or TUI command with
 * `runInPaneArgs`.
 */
export const PANE_GATE_COMMAND = 'exec /bin/bash --noprofile --norc'

export function newDetachedArgs(
  widgetId: string,
  cols: number,
  rows: number,
  confPath: string,
  cwd: string,
  environment: TmuxEnvironment = {},
): string[] {
  return newDetachedTargetArgs(internalTarget(widgetId), cols, rows, confPath, cwd, environment)
}

export function newDetachedTargetArgs(
  target: TmuxTarget,
  cols: number,
  rows: number,
  confPath: string,
  cwd: string,
  environment: TmuxEnvironment = {},
): string[] {
  const args = [
    ...socketArgs(target.socket),
    '-f',
    confPath,
    'new-session',
    '-d', // detached; the node-pty client attaches separately
    '-s',
    target.session,
    '-x',
    String(cols),
    '-y',
    String(rows),
    '-c',
    cwd,
  ]
  for (const [key, value] of Object.entries(environment)) args.push('-e', `${key}=${value}`)
  args.push(PANE_GATE_COMMAND)
  return args
}

/**
 * `tmux` argv that respawns the session's pane in `cwd`, killing whatever is
 * currently running (`-k`). Used by "Replace with <TUI>": one pane runs one
 * foreground program, so loading a TUI into a live widget atomically replaces
 * the old one. As with creation, the replacement starts in the fixed gate shell
 * so tmux can finish cgroup placement before `runInPaneArgs` starts the TUI.
 */
export function respawnArgs(
  widgetId: string,
  cwd: string,
  environment: TmuxEnvironment = {},
): string[] {
  return respawnTargetArgs(internalTarget(widgetId), cwd, environment)
}

export function respawnTargetArgs(
  target: TmuxTarget,
  cwd: string,
  environment: TmuxEnvironment = {},
): string[] {
  const args = targetArgs(target, ['respawn-pane', '-k', '-c', cwd, '-t', target.session])
  for (const [key, value] of Object.entries(environment)) args.push('-e', `${key}=${value}`)
  args.push(PANE_GATE_COMMAND)
  return args
}

/** Launch a command only after tmux has created and cgroup-migrated the gated
 * pane. This ordering is lifecycle-critical: giving the real user/TUI command
 * directly to new-session/respawn-pane lets shell RC files or that workload
 * fork before Ubuntu tmux finishes moving the pane into its dedicated scope. */
export function runInPaneArgs(widgetId: string, command: string): string[] {
  return runInPaneTargetArgs(internalTarget(widgetId), command)
}

export function runInPaneTargetArgs(target: TmuxTarget, command: string): string[] {
  return targetArgs(target, [
    'send-keys',
    '-t',
    target.session,
    'C-u',
    ';',
    'send-keys',
    '-t',
    target.session,
    '-l',
    command,
    ';',
    'send-keys',
    '-t',
    target.session,
    'Enter',
  ])
}

/**
 * `tmux` argv that inserts `text` at the prompt WITHOUT a trailing Enter. `-l`
 * sends the bytes literally (so snippet punctuation isn't read as key names),
 * leaving the user to add their ask and submit. Used by the selection grab.
 */
export function sendTextArgs(widgetId: string, text: string): string[] {
  return sendTextTargetArgs(internalTarget(widgetId), text)
}

export function sendTextTargetArgs(target: TmuxTarget, text: string): string[] {
  return targetArgs(target, ['send-keys', '-t', target.session, '-l', text])
}

/** `tmux` argv that attaches the node-pty client to an existing session. */
export function attachArgs(widgetId: string): string[] {
  return attachTargetArgs(internalTarget(widgetId))
}

export function attachTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, ['attach-session', '-t', target.session])
}

/**
 * `tmux` argv listing the client names attached to a widget's session, one per
 * line. Normally a single node-pty client; the refresh path iterates them so it
 * works even if more than one is somehow attached.
 */
export function listClientsArgs(widgetId: string): string[] {
  return listClientsTargetArgs(internalTarget(widgetId))
}

export function listClientsTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, ['list-clients', '-t', target.session, '-F', '#{client_name}'])
}

/** Stable server-assigned identity of an internal durable tmux session. */
export function sessionIdArgs(widgetId: string): string[] {
  return sessionIdTargetArgs(internalTarget(widgetId))
}

export function sessionIdTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, ['display-message', '-p', '-t', target.session, '#{session_id}'])
}

/**
 * Every pane currently belonging to a session, with server-stable pane ID and
 * root PID. Lifecycle code must fail closed unless exactly one row is present;
 * a session name alone is not a stable target after splits or replacements.
 */
export function listSessionPanesArgs(widgetId: string): string[] {
  return listSessionPanesTargetArgs(internalTarget(widgetId))
}

export function listSessionPanesTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, ['list-panes', '-t', target.session, '-F', '#{pane_id}\t#{pane_pid}'])
}

/** Pane diagnostics for the complete session. Lifecycle callers still require
 * exactly one row before treating any pane as the widget's owned root. */
export function listSessionPaneDetailsTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, [
    'list-panes',
    '-t',
    target.session,
    '-F',
    '#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}',
  ])
}

/** `tmux` argv that returns the root pid of a widget pane. Used to reconcile
 * persisted TUI metadata with the process actually running after manual shell
 * changes inside a widget. */
export function panePidArgs(widgetId: string): string[] {
  return panePidTargetArgs(internalTarget(widgetId))
}

export function panePidTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, ['display-message', '-p', '-t', target.session, '#{pane_pid}'])
}

/**
 * `tmux` argv that forces a full repaint of `client` from tmux's authoritative
 * grid. tmux holds the real screen state; the manual Refresh re-sends it to
 * recover a desynced xterm view (resize-reflow race, WebGL glitch, dropped bytes).
 */
export function refreshClientArgs(client: string, socket: string | null = TMUX_SOCKET): string[] {
  return [...socketArgs(socket), 'refresh-client', '-t', client]
}

/** Default-server panes that can be attached as external A-Term sessions. */
export function listDefaultPanesArgs(): string[] {
  return [
    'list-panes',
    '-a',
    '-F',
    '#{session_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}',
  ]
}
