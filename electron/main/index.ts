import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  session,
} from 'electron'
import { type IPty, spawn } from 'node-pty'
import { parseTerminalFontSettings } from '../shared/font-settings'
import {
  isDir,
  listProjects,
  onProjectsRefreshed,
  PERSONAL_WORKSPACE_ID,
  type ProjectInfo,
  projectRoot,
  refreshProjects,
  widgetCwd,
} from './project'
import { compactRef, parseSse, type SelectionRecord } from './selection'
import { bundledSidecar, Sidecar } from './sidecar'
import {
  getSetting,
  getWidget,
  hasWidget,
  initStore,
  insertExternalWidget,
  insertWidget,
  listWidgets,
  removeWidget,
  saveBounds,
  setOpen,
  setSetting,
  setWidgetName,
  setWidgetProject,
  setWidgetTool,
  type WidgetRow,
} from './store'
import { terminalClientEnv } from './terminal-env'
import {
  A_TERM_SESSION_PREFIX,
  attachTargetArgs,
  capturePageTargetArgs,
  captureTargetArgs,
  hasSessionArgs,
  hasTargetArgs,
  IDLE_TTL_MS,
  internalTarget,
  isATermSessionName,
  killArgs,
  listActivityArgs,
  listArgs,
  listClientsTargetArgs,
  listDefaultPanesArgs,
  newDetachedArgs,
  panePidTargetArgs,
  paneScrollbackInfoTargetArgs,
  refreshClientArgs,
  respawnArgs,
  scrollbackPageBounds,
  sendTextTargetArgs,
  staleWidgetIds,
  type TmuxTarget,
  tmuxConf,
  tmuxProfileArgs,
  widgetIdFromSession,
} from './tmux'
import { createTray, refreshTray, setWidgetActivity, type TrayWidget } from './tray'
import {
  ensureContext,
  getTui,
  launchLine,
  listTuis,
  paneCommand,
  registerBuiltinTuis,
} from './tui'
import { detectTuiFromProcessNames, parseProcessTable, processTreeNames } from './tui/detect'

const execFileAsync = promisify(execFile)
const SCROLLBACK_PAGE_DEFAULT_LINES = 5000
const SCROLLBACK_PAGE_MAX_LINES = 5000

function scrollbackPageCount(input: unknown): number {
  const n = typeof input === 'number' ? input : SCROLLBACK_PAGE_DEFAULT_LINES
  if (!Number.isFinite(n)) return SCROLLBACK_PAGE_DEFAULT_LINES
  return Math.min(SCROLLBACK_PAGE_MAX_LINES, Math.max(1, Math.floor(n)))
}

function scrollbackPageFromLine(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined
  return Math.max(0, Math.floor(input))
}

// One node-pty per open window. The PTY runs `tmux attach`; killing it only
// detaches the client, so the tmux session (and its shell) survives reload/close.
const ptys = new Map<number, IPty>()
// BrowserWindow.id -> stable widget id. The widget id (not the volatile window
// id) names the tmux session, so a widget reattaches the same session across
// close/reopen and app restarts.
const widgetOf = new Map<number, string>()
const boundsTimers = new Map<number, NodeJS.Timeout>()
let quitting = false

// Eyes-follow-cursor: while any widget is unfocused, broadcast the global cursor
// position so those widgets' eyes can track it. One shared interval feeds every
// window; the focused window ignores it and stares ahead. Runs only when at least
// one window is unfocused, so an all-focused desktop pays nothing.
const blurredWins = new Set<number>()
let cursorTimer: NodeJS.Timeout | undefined
let lastCursorPt: { x: number; y: number } | null = null
function syncCursorPump(): void {
  lastCursorPt = null // a focus change always gets one fresh send
  if (blurredWins.size > 0 && !cursorTimer) {
    cursorTimer = setInterval(() => {
      const pt = screen.getCursorScreenPoint()
      if (lastCursorPt && pt.x === lastCursorPt.x && pt.y === lastCursorPt.y) return
      lastCursorPt = pt
      for (const id of blurredWins) {
        const win = BrowserWindow.fromId(id)
        if (win && !win.isDestroyed()) win.webContents.send('win:cursor', pt)
      }
    }, 60)
  } else if (blurredWins.size === 0 && cursorTimer) {
    clearInterval(cursorTimer)
    cursorTimer = undefined
  }
}
// The widget that should receive an indicated selection: the last Aico widget
// the user focused. (During an indicate gesture the *browser* holds OS focus,
// so "active session" means most-recently-focused widget, not focused-now.)
let lastFocusedAico: string | null = null
// Aborts the sidecar SSE subscription (deliver-event stream) on quit.
let selectionEvents: AbortController | null = null

// System-wide "indicate" hotkey. Works on X11 today; on Wayland (GNOME 46, no
// GlobalShortcuts portal) globalShortcut silently no-ops — bind a GNOME custom
// shortcut to a CLI that poke this same grab path instead (follow-on).
const SELECTION_HOTKEY = process.env.AICO_SELECTION_HOTKEY ?? 'CommandOrControl+Shift+Space'

// Push-to-talk: a press toggles dictation on the focused widget (globalShortcut
// fires on press only — no key-release — so this is a toggle, not a hold). The
// renderer captures the mic and types the transcript into its own prompt.
const VOICE_PTT_HOTKEY = process.env.AICO_VOICE_HOTKEY ?? 'CommandOrControl+Shift+M'
// Optional voice websocket. user_id/app are accepted by the default local STT URL;
// mode=transcribe is appended by the client (transcript only, no voice-assistant
// completion — voice is dictation into the TUI, which then responds).
const VOICE_WS_URL =
  process.env.AICO_VOICE_WS ?? 'ws://127.0.0.1:8003/api/voice/ws?user_id=aico&app=aico'

interface PtySize {
  cols: number
  rows: number
}

// Clamp renderer-supplied terminal geometry to sane integers before it reaches
// tmux (-x/-y) and node-pty: a non-integer, negative, NaN, or absurd value would
// otherwise create a degenerate session or throw deep inside pty.resize.
const MAX_TERM_DIM = 1000
function clampDim(n: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(MAX_TERM_DIM, Math.max(1, Math.floor(n))) : fallback
}
function clampSize(size: PtySize): PtySize {
  return { cols: clampDim(size?.cols, 80), rows: clampDim(size?.rows, 24) }
}

const stateDir = process.env.AICO_STATE_DIR ?? join(homedir(), '.local', 'state', 'aico')
const tmuxConfPath = join(stateDir, 'tmux.conf')
const dbPath = join(stateDir, 'aico.db')

const sidecarHost = process.env.AICO_SIDECAR_HOST ?? '127.0.0.1'
const sidecarPort = Number(process.env.AICO_SIDECAR_PORT ?? 8005)
let sidecar: Sidecar | null = null

function newWidgetId(): string {
  return randomBytes(4).toString('hex')
}

function ensureTmuxConf(): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(tmuxConfPath, tmuxConf())
}

function syncTmuxProfile(): void {
  try {
    execFileSync('tmux', tmuxProfileArgs(), { env: terminalClientEnv(), stdio: 'ignore' })
  } catch {
    // No tmux server yet; the config file applies the same profile on create.
  }
}

function windowForWidget(id: string): BrowserWindow | undefined {
  for (const [winId, wid] of widgetOf) {
    if (wid === id) {
      const win = BrowserWindow.fromId(winId)
      if (win && !win.isDestroyed()) return win
    }
  }
  return undefined
}

function tmuxTargetForWidget(widgetId: string): TmuxTarget {
  const row = getWidget(widgetId)
  if (row?.externalTmuxSession) {
    return {
      socket: row.externalTmuxSocket,
      session: row.externalTmuxSession,
    }
  }
  return internalTarget(widgetId)
}

function isExternalTmuxWidget(widgetId: string): boolean {
  return Boolean(getWidget(widgetId)?.externalTmuxSession)
}

// The directory a widget's pane should spawn in. A widget bound to a workspace
// uses the root cached on its row — a plain column read, resolved once at
// switch time, so no `st` subprocess runs on the session-create/respawn path.
// Personal Workspace is resolved locally and never falls through to the active
// repo; unbound/legacy widgets still fall back to the global `st` active project,
// then $HOME. A vanished project root falls through so a stale binding never
// strands the pane.
function cwdForWidget(widgetId: string): string {
  const row = getWidget(widgetId)
  if (row?.projectId === PERSONAL_WORKSPACE_ID) {
    return projectRoot(PERSONAL_WORKSPACE_ID) ?? process.env.HOME ?? homedir()
  }
  const root = row?.projectRoot
  if (root && isDir(root)) return root
  return widgetCwd()
}

// Detect the TUI actually running in a widget's pane from its live process tree.
// Async (off the main thread): reconcileWidgetTool runs this on every focus, and
// reading the full `ps` table synchronously there would stall the UI thread on
// each window switch. Best-effort — any failure resolves to undefined.
async function liveTuiForWidget(widgetId: string): Promise<ReturnType<typeof getTui>> {
  try {
    const { stdout: pidOut } = await execFileAsync(
      'tmux',
      panePidTargetArgs(tmuxTargetForWidget(widgetId)),
    )
    const rootPid = Number(pidOut.trim())
    if (!Number.isFinite(rootPid) || rootPid <= 0) return undefined
    const { stdout: psOut } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,comm='])
    const names = processTreeNames(parseProcessTable(psOut), rootPid)
    return detectTuiFromProcessNames(listTuis(), names)
  } catch {
    return undefined
  }
}

// If the user exits one TUI manually and starts another inside the shell, tmux
// keeps the same widget session but Aico's stored `tool` slug can go stale. Use
// the live process tree to repair the titlebar/tray metadata on attach/focus.
// Resolves true when the stored slug changed, so callers can refresh the title.
async function reconcileWidgetTool(widgetId: string): Promise<boolean> {
  const row = getWidget(widgetId)
  if (!row) return false
  const live = await liveTuiForWidget(widgetId)
  if (!live || live.slug === row.tool) return false
  setWidgetTool(widgetId, live.slug)
  console.log(`[aico] reconciled ${widgetId} TUI metadata: ${row.tool} -> ${live.slug}`)
  return true
}

// Ensure the widget's tmux session exists, launching its TUI exactly once on
// first create. Reattaching a window finds the session already running and
// sends nothing — so a live agent is never relaunched. cwd is the widget's
// project root (per-widget binding, else the global `st` active project),
// captured when the session is first created; reattaching keeps wherever the
// agent already is.
function ensureSession(widgetId: string, size: PtySize): void {
  if (isExternalTmuxWidget(widgetId)) {
    try {
      execFileSync('tmux', hasTargetArgs(tmuxTargetForWidget(widgetId)), { stdio: 'ignore' })
    } catch (e) {
      console.error(`[aico] external tmux session for ${widgetId} is unavailable:`, e)
    }
    return
  }
  try {
    execFileSync('tmux', hasSessionArgs(widgetId), { stdio: 'ignore' })
    return // already running (reattach) — do not relaunch
  } catch {
    // not running; create it below
  }
  const cwd = cwdForWidget(widgetId)
  // The TUI (if any) is baked into session creation as the pane's own process,
  // so it paints clean — no interactive shell echoes the launch line into
  // scrollback above it. A bare shell (line === null) creates a plain session.
  const tool = getTui(getWidget(widgetId)?.tool ?? 'shell')
  const line = tool ? launchLine(tool) : null
  const command = line ? paneCommand(line) : undefined
  try {
    execFileSync(
      'tmux',
      newDetachedArgs(widgetId, size.cols, size.rows, tmuxConfPath, cwd, command),
      { env: terminalClientEnv() },
    )
  } catch (e) {
    // No session to attach to; surface why rather than letting startPty's attach
    // fail into a blank terminal with no explanation.
    console.error(`[aico] failed to create tmux session for ${widgetId}:`, e)
    return
  }
  // Verify-only; never blocks launch (a missing hook just means no mandates).
  if (tool && line) reportContext(widgetId, tool)
}

// Verify a TUI's mandate-injection hook and surface the result to its widget
// window: a persistent titlebar status badge (green tick when mandates inject,
// red warning when they won't) plus a warning toast on a `missing` launch. (The
// core product guarantee is that agents launch with their mandates; a silent
// console.log the packaged-app user never sees let a genuinely-missing hook
// launch an unguarded agent unnoticed.) Always emits — the badge reflects the
// latest verified state. Verify-only; never blocks.
function reportContext(widgetId: string, tool: NonNullable<ReturnType<typeof getTui>>): void {
  ensureContext(tool)
    .then((s) => {
      console.log(`[aico] ${tool.slug} context ${s.state}: ${s.detail}`)
      windowForWidget(widgetId)?.webContents.send('context:mandate', {
        slug: tool.slug,
        state: s.state,
        detail: s.detail,
        // Whether this TUI even carries mandates. A bare shell / opencode / pi has
        // no hook, so the badge stays hidden for it (an "injecting" tick there
        // would be a lie); claude/codex/gemini/hermes do, so the badge shows.
        applicable: tool.context !== undefined,
      })
    })
    .catch(() => {})
}

// Respawn a live widget's pane (kills the current foreground program, fresh
// shell in the widget's current cwd) and relaunch `tool` in it. One pane = one
// foreground program, so both "Replace with <TUI>" and "Open workspace" go through
// here — mirroring ensureSession's launch, but for an already-running widget.
// The cwd is resolved now, so callers that change the binding must persist it
// (setWidgetTool / setWidgetProject) before calling.
function respawnAndRelaunch(widgetId: string, tool: ReturnType<typeof getTui>): void {
  if (isExternalTmuxWidget(widgetId)) {
    console.warn(`[aico] refusing to respawn externally-owned tmux session ${widgetId}`)
    return
  }
  // Same as ensureSession: the TUI is respawned as the pane's own process so it
  // paints clean (no echoed launch line); a bare shell respawns a plain prompt.
  const line = tool ? launchLine(tool) : null
  const command = line ? paneCommand(line) : undefined
  try {
    execFileSync('tmux', respawnArgs(widgetId, cwdForWidget(widgetId), command))
  } catch (e) {
    // Respawn failed; the old foreground program is still running. Surface it
    // rather than silently leaving the stored tool/project out of sync.
    console.error(`[aico] failed to respawn pane for ${widgetId}:`, e)
    return
  }
  if (tool && line) reportContext(widgetId, tool)
}

// Replace whatever runs in a live widget's pane with `slug`'s TUI ("Replace
// with <TUI>"). The stored tool is updated so a later kill+recreate relaunches it.
function loadTui(widgetId: string, slug: string): void {
  const tool = getTui(slug)
  if (!tool) return
  setWidgetTool(widgetId, slug)
  respawnAndRelaunch(widgetId, tool)
}

// Move a live widget to another workspace ("Open workspace ▸"): resolve the
// project/workspace root once, cache it on the row, then respawn the pane there
// and relaunch the SAME tool it's already running. This does NOT touch the global
// `st` pointer — other widgets and brand-new ones are unaffected.
function switchProject(widgetId: string, projectId: string): void {
  const root = projectRoot(projectId)
  if (!root) console.warn(`[aico] workspace ${projectId} root unresolved; using default cwd`)
  setWidgetProject(widgetId, projectId, root)
  respawnAndRelaunch(widgetId, getTui(getWidget(widgetId)?.tool ?? 'shell'))
}

function startPty(win: BrowserWindow, size: PtySize): void {
  const widgetId = widgetOf.get(win.id)
  if (!widgetId) return
  const existing = ptys.get(win.id)
  if (existing) {
    existing.kill() // detaches the client; tmux session persists
    ptys.delete(win.id)
  }
  ensureSession(widgetId, size)
  // Non-blocking: repair stale TUI metadata from the live process tree, then
  // refresh the titlebar if it changed. The attach below proceeds immediately.
  void reconcileWidgetTool(widgetId).then((changed) => {
    if (changed) pushTitles()
  })
  const pty = spawn('tmux', attachTargetArgs(tmuxTargetForWidget(widgetId)), {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.env.HOME,
    env: terminalClientEnv(),
  })
  pty.onData((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('pty:data', data)
    }
  })
  pty.onExit(() => {
    // Only clear the map if this is still the current pty: a prior pty we killed
    // on re-attach can fire its exit after the replacement is stored, and an
    // unconditional delete would drop the live entry (orphaning it).
    if (ptys.get(win.id) === pty) ptys.delete(win.id)
  })
  ptys.set(win.id, pty)
}

function ptyFor(sender: Electron.WebContents): IPty | undefined {
  const win = BrowserWindow.fromWebContents(sender)
  return win ? ptys.get(win.id) : undefined
}

// Persist a window's bounds (and which monitor it's on) so it restores in place.
function persistBounds(win: BrowserWindow): void {
  const widgetId = widgetOf.get(win.id)
  if (!widgetId || win.isDestroyed() || !hasWidget(widgetId)) return
  const bounds = win.getBounds()
  saveBounds(widgetId, bounds, String(screen.getDisplayMatching(bounds).id))
}

function scheduleBoundsSave(win: BrowserWindow): void {
  const prev = boundsTimers.get(win.id)
  if (prev) clearTimeout(prev)
  boundsTimers.set(
    win.id,
    setTimeout(() => persistBounds(win), 400),
  )
}

// Restore a saved rect only if it still lands on a connected display; otherwise
// keep just the size and let the OS place it (avoids off-screen windows).
function placement(row: WidgetRow): Electron.BrowserWindowConstructorOptions {
  const b = row.bounds
  if (!b) return { width: 900, height: 560 }
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) => {
    return (
      b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y
    )
  })
  return onScreen
    ? { x: b.x, y: b.y, width: b.width, height: b.height }
    : { width: b.width, height: b.height }
}

function openWidget(row: WidgetRow): void {
  const win = new BrowserWindow({
    ...placement(row),
    minWidth: 360,
    minHeight: 240,
    // Lantern chrome: frameless + transparent so the renderer draws the frosted
    // shell, soft shadow, and breathing halo itself. Terminal area stays solid.
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    icon: join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      // Renderer runs in the OS sandbox. The preload is a pure contextBridge shim
      // (requires only electron's contextBridge/ipcRenderer, both available to a
      // sandboxed CommonJS preload), so nothing here needs Node at module scope.
      sandbox: true,
      // Keep painting while unfocused/occluded so the eyes can smoothly follow the
      // cursor (the gaze is driven by win:cursor ticks from the main process).
      backgroundThrottling: false,
    },
  })

  // Fixed local UI: no popups, and never navigate the frame away from the
  // renderer. Defense-in-depth so a renderer compromise can't open or redirect
  // to arbitrary content.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  const winId = win.id
  const widgetId = row.id
  widgetOf.set(winId, widgetId)
  setOpen(widgetId, true)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Make the mandate badge authoritative for THIS window the instant it loads,
  // not only when a TUI is freshly launched. On an aico restart we reattach to a
  // live tmux session WITHOUT relaunching (ensureSession returns early), so the
  // launch-time context:mandate never fires for a reattached pane — the badge
  // would otherwise be frozen at its hidden default and could never warn. The
  // fresh-launch path re-reports the same state moments later; this is idempotent.
  win.webContents.once('did-finish-load', () => {
    const tool = getTui(getWidget(widgetId)?.tool ?? 'shell')
    if (tool) reportContext(widgetId, tool)
  })

  // Renderer toggles the focused/unfocused chrome state off these. Focus also
  // records this widget as the selection-grab target ("last-focused widget").
  win.on('focus', () => {
    const widgetId = widgetOf.get(win.id)
    lastFocusedAico = widgetId ?? lastFocusedAico
    if (widgetId) {
      void reconcileWidgetTool(widgetId).then((changed) => {
        if (changed) pushTitles()
      })
    }
    win.webContents.send('win:focus', true)
    blurredWins.delete(win.id)
    syncCursorPump()
  })
  win.on('blur', () => {
    win.webContents.send('win:focus', false)
    blurredWins.add(win.id)
    syncCursorPump()
  })

  win.on('move', () => scheduleBoundsSave(win))
  win.on('resize', () => scheduleBoundsSave(win))
  win.on('close', () => persistBounds(win)) // final flush while bounds are still valid

  win.on('closed', () => {
    const pty = ptys.get(winId)
    if (pty) {
      pty.kill() // detach; tmux session persists (close = keep, reopenable)
      ptys.delete(winId)
    }
    const timer = boundsTimers.get(winId)
    if (timer) {
      clearTimeout(timer)
      boundsTimers.delete(winId)
    }
    setWidgetActivity(winId, false)
    widgetOf.delete(winId)
    blurredWins.delete(winId)
    syncCursorPump()
    // On quit, leave `open` as-is so live widgets restore next launch; on an
    // explicit close, mark it closed (it moves to the tray's reopen list).
    if (!quitting && hasWidget(widgetId)) setOpen(widgetId, false)
    syncTray()
  })

  syncTray()
}

// Create a widget running `tool`, bound to `projectId` from the moment it's
// born: the project's root is resolved once here (the same deliberate `st` call
// switchProject makes) and cached on the row, so the pane spawns in that dir and
// the titlebar reads that project — neither follows the global pointer later. A
// root that won't resolve still binds the id (cwd then falls back, never strands).
function newWidget(tool: string, projectId: string): void {
  const id = newWidgetId()
  const row = insertWidget(id, true, tool)
  const root = projectRoot(projectId)
  if (!root) console.warn(`[aico] workspace ${projectId} root unresolved; using default cwd`)
  setWidgetProject(id, projectId, root)
  openWidget(row)
}

interface AttachableTmuxSession {
  id: string
  label: string
  source: string
  socket: string | null
  session: string
  cwd: string | null
  command: string
  tool: string
}

function listAttachableTmuxSessions(): AttachableTmuxSession[] {
  let out = ''
  try {
    out = execFileSync('tmux', listDefaultPanesArgs(), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }

  const bySession = new Map<string, AttachableTmuxSession>()
  for (const line of out.split('\n')) {
    const [sessionName, _paneId, cwd, command] = line.split('\t')
    if (!sessionName || !isATermSessionName(sessionName)) continue
    const existing = bySession.get(sessionName)
    if (existing?.cwd) continue
    const liveTui = detectTuiFromProcessNames(listTuis(), [command || ''])
    bySession.set(sessionName, {
      id: `default:${sessionName}`,
      label: `A-Term ${sessionName.slice(A_TERM_SESSION_PREFIX.length, A_TERM_SESSION_PREFIX.length + 8)}`,
      source: 'A-Term',
      socket: null,
      session: sessionName,
      cwd: cwd || null,
      command: command || 'shell',
      tool: liveTui?.slug ?? 'shell',
    })
  }
  return [...bySession.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function findWidgetByTmuxTarget(target: TmuxTarget): WidgetRow | undefined {
  return listWidgets().find(
    (row) =>
      row.externalTmuxSession === target.session &&
      (row.externalTmuxSocket ?? null) === target.socket,
  )
}

function attachExternalTmuxSession(attachableId: string): void {
  const session = listAttachableTmuxSessions().find((item) => item.id === attachableId)
  if (!session) return
  const target = { socket: session.socket, session: session.session }
  const existing = findWidgetByTmuxTarget(target)
  if (existing) {
    focusOrReopen(existing.id)
    return
  }
  const row = insertExternalWidget(
    newWidgetId(),
    true,
    session.socket,
    session.session,
    session.label,
    session.tool,
  )
  openWidget(row)
}

function focusOrReopen(id: string): void {
  const win = windowForWidget(id)
  if (win) {
    win.show()
    win.focus()
    return
  }
  const row = getWidget(id)
  if (row) openWidget(row)
}

function discardWidget(id: string): void {
  windowForWidget(id)?.destroy() // detaches via 'closed'; session killed next
  if (!isExternalTmuxWidget(id)) {
    execFile('tmux', killArgs(id), () => {}) // best-effort; ignore "no such session"
  }
  removeWidget(id)
  syncTray()
}

// Hub view: surface every widget. Shared by the tray and the in-widget control
// surface so both stay one behavior. (Phase 1 replaces this with the cascade grid.)
function showHub(): void {
  for (const win of BrowserWindow.getAllWindows()) win.show()
}

function syncTray(): void {
  const projects = listProjects() // titlebar name fallback + the New-widget submenu
  const attachables = listAttachableTmuxSessions()
  const widgets: TrayWidget[] = listWidgets().map((w) => ({
    id: w.id,
    label: w.name || widgetProjectName(w, projects) || `Widget ${w.seq}`,
    open: windowForWidget(w.id) !== undefined,
  }))
  refreshTray(widgets, projects, attachables)
}

// The workspace an unnamed widget reads as: the one it's bound to (pinned at
// creation, or last "Open workspace"). Used only as the title fallback, so a
// widget shows its actual workspace instead of a bare ordinal — and never drifts
// with the global pointer. null for an unbound/legacy row (⇒ `Widget ${seq}`).
function widgetProjectName(row: WidgetRow, projects: ProjectInfo[]): string | null {
  if (!row.projectId) return null
  return projects.find((p) => p.id === row.projectId)?.name ?? null
}

// Push titlebar info to every open window: the widget's name (custom, else its
// workspace, else `Widget ${seq}`) shown centered, plus its TUI's SVG mark + accent
// (drawn between the eyes). All of it changes only on Aico events — attach, rename,
// "Replace with <TUI>", "Open workspace" — so this is event-driven, not polled.
function pushTitles(): void {
  const projects = listProjects() // cached; never blocks this event path
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const widgetId = widgetOf.get(win.id)
    const row = widgetId ? getWidget(widgetId) : undefined
    if (!row) continue
    const tui = getTui(row.tool) ?? getTui('shell')
    win.webContents.send('win:title', {
      // Custom name wins (a prior edit is never overwritten); otherwise track
      // the live project so the bar follows whatever's loaded.
      label: row.name || widgetProjectName(row, projects) || `Widget ${row.seq}`,
      name: row.name, // custom name (or null) — prefills the rename input
      icon: tui?.icon ?? '',
      accent: tui?.accent ?? '',
      tuiName: tui?.displayName ?? '',
      tuiSlug: tui?.slug ?? 'shell',
    })
  }
}

// Adopt any live `aico-*` tmux sessions not yet in the catalog as closed
// widgets, preserving their creation time — so sessions from before this
// catalog existed (and any external strays) stay reachable via the tray.
function adoptOrphans(): void {
  let out = ''
  try {
    out = execFileSync('tmux', listArgs(), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return // no tmux server => no sessions to adopt
  }
  for (const line of out.split('\n')) {
    const [name, created] = line.trim().split(' ')
    if (!name) continue
    const id = widgetIdFromSession(name)
    if (id && !hasWidget(id)) {
      const createdAt = Number(created) ? Number(created) * 1000 : Date.now()
      insertWidget(id, false, 'shell', createdAt) // pre-existing sessions are bare shells
    }
  }
}

// Reap aico sessions left idle past the TTL and not currently attached, so
// forgotten sessions don't accumulate on the tmux server over many days. Runs
// once at launch, before adoptOrphans catalogs the survivors; an open widget's
// session is attached and so is never touched. Best-effort throughout.
function reapIdleSessions(): void {
  let out = ''
  try {
    out = execFileSync('tmux', listActivityArgs(), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return // no tmux server => nothing to reap
  }
  for (const id of staleWidgetIds(out, Date.now(), IDLE_TTL_MS)) {
    try {
      execFileSync('tmux', killArgs(id), { stdio: 'ignore' })
    } catch {
      // session vanished between list and kill — fine
    }
    if (hasWidget(id)) removeWidget(id) // drop the catalog row too: fully retired
  }
}

function restoreOnLaunch(): void {
  reapIdleSessions()
  adoptOrphans()
  const all = listWidgets() // oldest first
  const open = all.filter((w) => w.open)
  if (open.length) {
    open.forEach(openWidget)
  } else if (all.length) {
    openWidget(all[0]) // nothing was open: bring back the oldest (the historical primary)
  }
  // Empty catalog: no widget to auto-launch (a launch now needs an explicit
  // TUI + project). The tray's "New widget ▸ TUI ▸ project" menu starts the first.
}

// The widget that should receive an indicated selection: the last-focused one
// if it's still open, else the most recently created open widget.
function selectionTarget(): string | undefined {
  if (lastFocusedAico && windowForWidget(lastFocusedAico)) return lastFocusedAico
  const open = listWidgets().filter((w) => windowForWidget(w.id))
  return open.length ? open[open.length - 1].id : undefined
}

// Shared deliver path for every trigger (X11 hotkey + browser-driven SSE):
// insert a compact reference at the target widget's prompt (no Enter — the user
// adds their ask and submits), then flash a toast. Best-effort: empty payload or
// no open widget no-ops silently.
function deliverSelection(records: SelectionRecord[]): void {
  const usable = records.filter((r) => r?.kind && r.kind !== 'empty')
  if (!usable.length) return
  const targetId = selectionTarget()
  if (!targetId) return
  try {
    execFileSync('tmux', sendTextTargetArgs(tmuxTargetForWidget(targetId), compactRef(usable)))
  } catch (err) {
    console.warn('[aico] selection insert failed:', err)
    return
  }
  const win = windowForWidget(targetId)
  if (win) {
    win.show()
    win.focus()
    const head = usable[0]
    win.webContents.send('selection:toast', {
      kind: usable.length > 1 ? `${usable.length} items` : head.kind,
      snippet: usable.length > 1 ? usable.map((r) => r.snippet ?? '').join(' · ') : head.snippet,
    })
  }
}

// Push-to-talk: route the toggle to the widget the user is talking to — the
// focused Aico window, falling back to the same target the selection bus uses
// (last-focused open widget). That renderer owns the mic capture + insert.
function toggleVoice(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const win =
    focused && widgetOf.has(focused.id) ? focused : windowForWidget(selectionTarget() ?? '')
  win?.webContents.send('voice:toggle')
}

// "Indicate" hotkey (X11 fallback for non-web sources): harvest the freshest
// capture from the bus and deliver it. Browser sends arrive via SSE instead.
async function selectionGrab(): Promise<void> {
  try {
    const res = await fetch(`http://${sidecarHost}:${sidecarPort}/selection/current`)
    if (!res.ok) return
    deliverSelection([(await res.json()) as SelectionRecord])
  } catch {
    // sidecar unreachable — best-effort
  }
}

// Run a desktop grab from a click (the menu rows). The same `scripts/aico-grab.sh`
// the global hotkeys fire, but invoked deliberately: clicking a window grab passes
// `-p` so the user picks the target window (the focused window is Aico's menu, so a
// bare focused-window grab would only ever shoot Aico), and a region grab passes
// `-r`. Env mirrors the hotkey install: keep a usable DISPLAY fallback and
// prepend common user bin dirs where optional capture tools may live.
// Resolve a bundled `scripts/` file to a real on-disk path bash can exec. When
// packaged, scripts/ is asar-unpacked (a script inside app.asar can't be run by
// a child process), so point at the unpacked mirror under resources.
function scriptsRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
}

function runDesktopGrab(args: string[]): void {
  const script = join(scriptsRoot(), 'scripts', 'aico-grab.sh')
  const home = homedir()
  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    PATH: `${home}/bin:${home}/.local/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
  }
  execFile('bash', [script, ...args], { env }, (err) => {
    if (err) console.warn('[aico] desktop grab failed:', err.message)
  })
}

// Subscribe to the sidecar's deliver-event stream so a browser-side "send"
// (extension pill / right-click / picker) reaches the same insert path as the
// hotkey. Reconnects with backoff across sidecar restarts; cancelled on quit.
// This is also the Wayland-safe trigger (a CLI POST to /selection/send fires it).
function subscribeSelectionEvents(): void {
  selectionEvents = new AbortController()
  const url = `http://${sidecarHost}:${sidecarPort}/selection/events`
  void (async () => {
    while (!quitting) {
      try {
        const res = await fetch(url, { signal: selectionEvents?.signal })
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const { events, rest } = parseSse(buf)
          buf = rest
          for (const data of events) {
            try {
              const payload = JSON.parse(data) as { records?: SelectionRecord[] }
              if (payload.records?.length) deliverSelection(payload.records)
            } catch {
              // malformed frame — skip
            }
          }
        }
      } catch {
        if (quitting || selectionEvents?.signal.aborted) return
      }
      await new Promise((r) => setTimeout(r, 1000)) // backoff before reconnect
    }
  })()
}

// Lock the renderer to a strict CSP in production (the packaged file:// app).
// Dev (ELECTRON_RENDERER_URL) is skipped: Vite's HMR needs inline/eval and its
// own websocket. connect-src is opened only to the voice WS; everything else is
// 'self'. Defense-in-depth so a renderer XSS can't reach arbitrary origins.
function installContentSecurityPolicy(): void {
  if (process.env.ELECTRON_RENDERER_URL) return // dev server: leave Vite's needs alone
  let wsOrigin = ''
  try {
    const u = new URL(VOICE_WS_URL)
    wsOrigin = `${u.protocol}//${u.host}`
  } catch {
    // malformed override — connect-src stays 'self' only
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'", // xterm.js injects a <style> for theming
    "img-src 'self' data:", // inline SVG marks + the chrome noise data: URI
    "font-src 'self'",
    `connect-src 'self'${wsOrigin ? ` ${wsOrigin}` : ''}`, // voice WS only
    "worker-src 'self' blob:", // voice audio worklet
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

function startSidecar(): void {
  // Packaged: spawn the bundled PyInstaller executable from resources (no Python
  // needed). Dev: `app.getAppPath()` is the repo root, so resolvePython finds the
  // .venv and runs `-m aico_sidecar`. The packaged spawn cwd is a real directory
  // (resourcesPath) since app.asar isn't a chdir-able path.
  const packaged = app.isPackaged
  const repoRoot = packaged ? process.resourcesPath : app.getAppPath()
  const command = packaged ? bundledSidecar(process.resourcesPath) : undefined
  const args = packaged ? [] : undefined
  sidecar = new Sidecar(
    { host: sidecarHost, port: sidecarPort, repoRoot, stateDir, command, args },
    (status, detail) => console.log(`[aico] sidecar ${status}${detail ? `: ${detail}` : ''}`),
  )
  // Fire-and-forget: widgets render against tmux without the sidecar, so don't
  // gate the UI on it; the health result is logged via onStatus.
  sidecar.start().catch((err) => console.warn('[aico] sidecar start failed:', err))
}

app.on('before-quit', () => {
  quitting = true
  // A secondary instance (single-instance lock denied) quits before the app is
  // ready, where globalShortcut would throw; it never registered any anyway.
  if (app.isReady()) globalShortcut.unregisterAll()
  selectionEvents?.abort()
  sidecar?.stop()
})

// Single-instance lock: a second launch must not spawn a duplicate (it would
// fight over the sidecar port :8005 and re-adopt the same widget catalog). The
// secondary quits immediately; the primary surfaces its widgets instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  for (const win of BrowserWindow.getAllWindows()) win.show()
  BrowserWindow.getAllWindows()[0]?.focus()
})

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return // secondary instance: app.quit() is pending
  registerBuiltinTuis()
  ensureTmuxConf()
  syncTmuxProfile()
  initStore(dbPath)
  installContentSecurityPolicy()
  startSidecar()

  // Project names render from the cache; repaint whenever a background `st`
  // read lands (including the startup prime below).
  onProjectsRefreshed(() => {
    pushTitles()
    syncTray()
  })
  void refreshProjects()

  // No application menu — the Lantern chrome owns window controls, and the
  // default Edit menu's paste role mangled bracketed paste (handled in renderer).
  Menu.setApplicationMenu(null)

  ipcMain.on('pty:start', (event, size: PtySize) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      startPty(win, clampSize(size))
      pushTitles() // fill the titlebar once the session is attached
    }
  })

  ipcMain.on('pty:input', (event, data: string) => {
    ptyFor(event.sender)?.write(data)
  })

  ipcMain.on('pty:resize', (event, size: PtySize) => {
    const pty = ptyFor(event.sender)
    if (pty) {
      const { cols, rows } = clampSize(size)
      try {
        pty.resize(cols, rows)
      } catch (err) {
        console.warn('[aico] pty resize failed:', err)
      }
    }
  })

  // Manual Refresh: tmux holds the authoritative grid, so force every client
  // attached to this widget's session to repaint from it — recovering an xterm
  // view that desynced (resize-reflow race, WebGL glitch, dropped/duped bytes).
  // Best-effort: a missing session or no clients is a no-op, never a crash.
  ipcMain.on('pty:refresh', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    if (!widgetId) return
    const target = tmuxTargetForWidget(widgetId)
    try {
      const out = execFileSync('tmux', listClientsTargetArgs(target), { encoding: 'utf8' })
      for (const client of out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)) {
        execFileSync('tmux', refreshClientArgs(client, target.socket), { stdio: 'ignore' })
      }
    } catch (err) {
      console.warn('[aico] pty refresh failed:', err)
    }
  })

  // Full scrollback for the renderer's read-only overlay. tmux history is the
  // source of truth (an attached tmux client has no xterm-side scrollback).
  ipcMain.handle('tmux:capture', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    if (!widgetId) return ''
    const { stdout } = await execFileAsync(
      'tmux',
      captureTargetArgs(tmuxTargetForWidget(widgetId)),
      {
        maxBuffer: 64 * 1024 * 1024, // 100k lines of history can be large
      },
    )
    return stdout
  })

  ipcMain.handle('tmux:scrollback-page', async (event, request?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    if (!widgetId) return { fromLine: 0, totalLines: 0, text: '' }

    const target = tmuxTargetForWidget(widgetId)
    const req =
      request && typeof request === 'object'
        ? (request as { fromLine?: unknown; count?: unknown })
        : {}
    const count = scrollbackPageCount(req.count)
    const requestedFromLine = scrollbackPageFromLine(req.fromLine)

    const { stdout: info } = await execFileAsync('tmux', paneScrollbackInfoTargetArgs(target), {
      maxBuffer: 1024,
    })
    const [historyRaw, heightRaw] = info.trim().split(/\s+/)
    const historySize = Number(historyRaw)
    const paneHeight = Number(heightRaw)
    const bounds = scrollbackPageBounds(historySize, paneHeight, count, requestedFromLine)
    if (!bounds) return { fromLine: 0, totalLines: 0, text: '' }

    const { stdout } = await execFileAsync('tmux', capturePageTargetArgs(target, bounds), {
      maxBuffer: 16 * 1024 * 1024,
    })
    return { fromLine: bounds.fromLine, totalLines: bounds.totalLines, text: stdout }
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_event, text: string) => clipboard.writeText(text))

  ipcMain.on('win:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('win:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })
  ipcMain.on('win:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.on('win:set-bounds', (event, b: { x: number; y: number; w: number; h: number }) => {
    BrowserWindow.fromWebContents(event.sender)?.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.w),
      height: Math.round(b.h),
    })
  })
  ipcMain.on('win:thinking', (event, on: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) setWidgetActivity(win.id, on)
  })

  // Control-surface actions: same handlers the tray uses. A new widget is always
  // an explicit (TUI, project) pair from the picker — both required, both checked
  // (untrusted renderer input), so a malformed call is ignored, not defaulted.
  ipcMain.on('widget:new', (_event, tool?: unknown, projectId?: unknown) => {
    if (typeof tool === 'string' && tool && typeof projectId === 'string' && projectId) {
      newWidget(tool, projectId)
    }
  })
  ipcMain.on('widget:hub', showHub)
  ipcMain.on('selection:grab', () => void selectionGrab())
  // Desktop grab fired from a menu click (window pick / region drag). Args are the
  // aico-grab.sh flags chosen by the renderer; validated to a small allowlist.
  ipcMain.on('grab:run', (_event, args: string[]) => {
    const allowed = new Set(['-p', '-t', '-r'])
    if (Array.isArray(args) && args.every((a) => allowed.has(a))) runDesktopGrab(args)
  })

  // Retire this widget from the widget itself: close the window AND end its tmux
  // session (same teardown as the tray's "Discard"), so the user need not go to
  // the tray. Resolves the widget id from the sender's window.
  ipcMain.on('widget:discard-self', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const id = win ? widgetOf.get(win.id) : undefined
    if (id) discardWidget(id)
  })

  // Replace the focused widget's running TUI with another (no new window).
  ipcMain.on('widget:load-tui', (event, slug?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const id = win ? widgetOf.get(win.id) : undefined
    if (id && slug) {
      loadTui(id, slug)
      pushTitles() // the TUI changed — refresh its titlebar icon now
    }
  })

  // Move the focused widget to another workspace (lantern-menu "Open workspace ▸"
  // flyout): respawn its pane there, same tool. Resolves the widget from the
  // sender's window, exactly like widget:load-tui.
  ipcMain.on('widget:switch-project', (event, projectId?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const id = win ? widgetOf.get(win.id) : undefined
    if (id && projectId) {
      switchProject(id, projectId)
      pushTitles() // the binding changed — an unnamed widget retitles to it
      syncTray()
    }
  })

  // Rename a widget from its titlebar (click the name). Empty/whitespace clears
  // it back to `Widget ${seq}`. Persisted, then reflected in the title and tray.
  ipcMain.on('widget:set-name', (event, name: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const id = win ? widgetOf.get(win.id) : undefined
    if (!id) return
    setWidgetName(id, typeof name === 'string' ? name : null)
    pushTitles()
    syncTray()
  })

  // The enabled TUIs (registry order) so the lantern menu can offer a picker —
  // same source the tray's "New widget" submenu reads.
  ipcMain.handle('tui:list', () =>
    listTuis().map((t) => ({ slug: t.slug, displayName: t.displayName, accent: t.accent })),
  )

  // Aico workspace catalog for the lantern menu's "Open workspace ▸" flyout
  // (Personal Workspace + optional st projects). Personal Workspace remains even
  // if `st` is unavailable.
  ipcMain.handle('project:list', () => listProjects())

  ipcMain.handle('tmux:list-attachable', () =>
    listAttachableTmuxSessions().map((s) => ({
      id: s.id,
      label: s.label,
      source: s.source,
    })),
  )
  ipcMain.on('tmux:attach', (_event, id?: unknown) => {
    if (typeof id === 'string' && id) attachExternalTmuxSession(id)
  })

  // Global pinned-action set (one row in aico.db, shared across widgets). A
  // setPins from any widget persists and broadcasts so every cluster updates.
  ipcMain.handle('settings:get-pins', () => {
    const raw = getSetting('pins')
    if (raw == null) return null
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as string[]) : null
    } catch {
      return null
    }
  })
  ipcMain.on('settings:set-pins', (_event, ids: string[]) => {
    setSetting('pins', JSON.stringify(ids))
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings:pins-changed', ids)
    }
  })

  ipcMain.handle('settings:get-terminal-font', () => {
    const raw = getSetting('terminal-font')
    if (raw == null) return null
    try {
      return parseTerminalFontSettings(JSON.parse(raw))
    } catch {
      return null
    }
  })
  ipcMain.on('settings:set-terminal-font', (_event, payload: unknown) => {
    const settings = parseTerminalFontSettings(payload)
    setSetting('terminal-font', JSON.stringify(settings))
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings:terminal-font-changed', settings)
    }
  })

  createTray(
    {
      onSelect: focusOrReopen,
      onDiscard: discardWidget,
      onNewWidget: newWidget,
      onAttachTmuxSession: attachExternalTmuxSession,
      onHubView: showHub,
    },
    listTuis().map((t) => ({ slug: t.slug, label: t.displayName })),
    listProjects(),
    listAttachableTmuxSessions(),
  )

  // System-wide indicate hotkey (X11). Logs whether the grab actually took, so
  // a silent Wayland no-op is visible in the launcher log.
  const hotkeyOk = globalShortcut.register(SELECTION_HOTKEY, () => void selectionGrab())
  console.log(
    `[aico] selection hotkey ${SELECTION_HOTKEY}: ${
      hotkeyOk ? 'registered' : 'unavailable (Wayland? bind a GNOME shortcut to the grab path)'
    }`,
  )

  // Push-to-talk hotkey (X11). Same Wayland caveat as the selection hotkey.
  ipcMain.handle('voice:ws-url', () => VOICE_WS_URL)
  // getUserMedia is denied by default; allow only mic capture, only for our app.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media'),
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
  const voiceHotkeyOk = globalShortcut.register(VOICE_PTT_HOTKEY, toggleVoice)
  console.log(
    `[aico] voice PTT hotkey ${VOICE_PTT_HOTKEY}: ${
      voiceHotkeyOk ? 'registered' : 'unavailable (Wayland? bind a GNOME shortcut to toggle voice)'
    }`,
  )

  // Browser-driven sends (and any CLI POST to /selection/send) arrive here.
  subscribeSelectionEvents()

  restoreOnLaunch()
  syncTray()

  app.on('activate', () => {
    // No windows: reopen the oldest catalogued widget (as on launch). With an
    // empty catalog there's nothing to auto-spawn — a launch needs an explicit
    // TUI + project — so the tray stays the entry point.
    if (BrowserWindow.getAllWindows().length > 0) return
    const oldest = listWidgets()[0]
    if (oldest) focusOrReopen(oldest.id)
  })
})

app.on('window-all-closed', () => {
  // Aico lives in the tray after the last widget closes; Quit (tray) exits.
})
