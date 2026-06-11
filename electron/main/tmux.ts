// tmux session model. Pure helpers (no electron/node-pty imports) so they
// unit-test cheaply. Aico runs its own isolated tmux server on a private
// socket ("-L aico") so it never touches the user's normal tmux sessions.

export const TMUX_SOCKET = 'aico'
// A-Term currently exposes attachable tmux sessions with this legacy prefix.
export const A_TERM_SESSION_PREFIX = 'summitflow-'

export interface TmuxTarget {
  socket: string | null
  session: string
}

export interface ScrollbackPageBounds {
  fromLine: number
  toLineExclusive: number
  totalLines: number
  startCoord: number
  endCoord: number
}

export function internalTarget(widgetId: string): TmuxTarget {
  return { socket: TMUX_SOCKET, session: sessionName(widgetId) }
}

function socketArgs(socket: string | null): string[] {
  return socket ? ['-L', socket] : []
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
  return ['-L', TMUX_SOCKET, ...commands.flatMap((args, i) => (i === 0 ? args : [';', ...args]))]
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
  return ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name} #{session_created}']
}

/** `tmux` argv that kills a widget's session (used by an explicit Discard). */
export function killArgs(widgetId: string): string[] {
  return killTargetArgs(internalTarget(widgetId))
}

export function killTargetArgs(target: TmuxTarget): string[] {
  return targetArgs(target, ['kill-session', '-t', target.session])
}

/** Sessions untouched longer than this (and unattached) are reaped at launch, so
 * forgotten sessions don't pile up on the server across days. 72h keeps anything
 * worked on yesterday — or over a normal weekend — alive to reattach. */
export const IDLE_TTL_MS = 72 * 60 * 60 * 1000

/**
 * `tmux` argv listing each session as
 * "<session_name> <activity_epoch_seconds> <attached_count>" — the inputs the
 * idle reaper needs to decide what's stale and unattached.
 */
export function listActivityArgs(): string[] {
  return [
    '-L',
    TMUX_SOCKET,
    'list-sessions',
    '-F',
    '#{session_name} #{session_activity} #{session_attached}',
  ]
}

/**
 * Widget ids of `aico-*` sessions that are stale (last activity older than
 * `ttlMs`) AND have no client attached. Pure (takes `now`/`ttlMs`, parses raw
 * `listActivityArgs` stdout) so it unit-tests without a tmux server. An attached
 * session — i.e. an open widget — is never reaped regardless of idle time.
 */
export function staleWidgetIds(lines: string, now: number, ttlMs: number): string[] {
  const stale: string[] = []
  for (const line of lines.split('\n')) {
    const parts = line.trim().split(' ')
    if (parts.length < 3) continue
    const [name, activity, attached] = parts
    const id = widgetIdFromSession(name)
    if (!id) continue // not an aico session
    if (attached !== '0') continue // a client is attached — leave it
    const last = Number(activity)
    if (!Number.isFinite(last) || last <= 0) continue // unknown activity — keep it
    if (now - last * 1000 > ttlMs) stale.push(id)
  }
  return stale
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
 * window must not relaunch a running agent. `command` (when given) becomes the
 * pane's process directly, so the TUI is the pane from the first paint — no
 * interactive shell echoes the launch line into scrollback above it; without it
 * the pane is a plain shell.
 */
export function newDetachedArgs(
  widgetId: string,
  cols: number,
  rows: number,
  confPath: string,
  cwd: string,
  command?: string,
): string[] {
  const args = [
    '-L',
    TMUX_SOCKET,
    '-f',
    confPath,
    'new-session',
    '-d', // detached; the node-pty client attaches separately
    '-s',
    sessionName(widgetId),
    '-x',
    String(cols),
    '-y',
    String(rows),
    '-c',
    cwd,
  ]
  if (command) args.push(command) // trailing shell-command → the pane's process
  return args
}

/**
 * `tmux` argv that respawns the session's pane in `cwd`, killing whatever is
 * currently running (`-k`). Used by "Replace with <TUI>": one pane runs one
 * foreground program, so loading a TUI into a live widget atomically replaces
 * the old one. `command` (when given) becomes the new pane process directly (no
 * echoed launch line); without it the pane respawns as a plain shell.
 */
export function respawnArgs(widgetId: string, cwd: string, command?: string): string[] {
  const args = ['-L', TMUX_SOCKET, 'respawn-pane', '-k', '-c', cwd, '-t', sessionName(widgetId)]
  if (command) args.push(command) // trailing shell-command → the pane's process
  return args
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
