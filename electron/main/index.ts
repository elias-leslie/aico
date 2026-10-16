import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
} from 'electron'
import { spawn } from 'node-pty'
import { parseTerminalFontSettings } from '../shared/font-settings'
import { cursorNearTitlebar, nextArcade, parseArcadeKeys, pickArcade } from './arcade'
import {
  Attention,
  type AttentionMode,
  type AttentionStage,
  agentName,
  groupRows,
  pushBody,
  pushEventLine,
  pushOutcome,
} from './attention'
import { contentSecurityPolicy, voiceConnectSource } from './csp'
import {
  allLookAt,
  arrange,
  DEFAULT_EYE_ANCHOR,
  type Face,
  type LayoutWindow,
  layoutSnapshot,
  type Point,
  pickScene,
  SCENE_EVERY_MS,
} from './gaze'
import { parseBoundsRequest, parsePins } from './ipc-validation'
import { allowTrustedAudioMedia } from './media-permission'
import { ownStartTime, removeOwnPidFile } from './process-identity'
import {
  ensurePersonalWorkspaceRoot,
  PERSONAL_WORKSPACE_ID,
  ProjectCatalog,
  personalWorkspaceRoot,
} from './project'
import { parseSse, type SelectionRecord } from './selection'
import { deliverSelectionToSession } from './selection-delivery'
import {
  coordinatorChip,
  createSessionCatalog,
  type SessionCatalog,
  sessionTitle,
  toolDisplayName,
  traySessionLabel,
} from './session-catalog'
import { bundledSidecar, Sidecar } from './sidecar'
import {
  type AttachTarget,
  attachEnvironment,
  attachSocketTarget,
  compatibleVersion,
  eventSession,
  followEvents,
  type GuiCommand,
  type GuiVerdict,
  holdGuiChannel,
  LEGACY_SESSION_NAME,
  type SessionDescriptor,
  TetherClient,
  TetherError,
  type TetherEvent,
  type TetherTool,
  TetherUnavailable,
  tetherSocketPath,
} from './tether-client'
import { ControlTerminal, type TerminalLink } from './tmux-control'
import { coalesceAsync, coalesceTrailingAsync, refreshAttachedClients } from './tmux-view'
import { toolMark } from './tool-marks'
import { createTray, refreshTray, setNeedsYou, setWidgetActivity, type TrayWidget } from './tray'
import {
  type Bounds,
  ensureView,
  getSetting,
  getView,
  initViews,
  listViews,
  removeView,
  saveBounds,
  setOpen,
  setSetting,
  type ViewRow,
} from './views'

const execFileAsync = promisify(execFile)
const TMUX_QUERY_TIMEOUT_MS = 2_000

// Tether owns every session: tmux servers, panes, agent launch, End and the
// root contract. Aico shows sessions in windows (views) and keeps their
// geometry and its settings. A window's PTY runs the exact `tmux attach` argv
// Tether hands out; killing that PTY only detaches, so the session survives
// close, reload and Aico restarts.
const tether = new TetherClient(tetherSocketPath())
const catalog: SessionCatalog = createSessionCatalog()
let tetherConnected = false
let tetherIncompatible: string | null = null
let tools: TetherTool[] = []
let restored = false

// One terminal link per open window, and the attach target it was started from.
// A link is either a node-pty running `tmux attach` or a tmux control-mode
// client (tmux-control.ts); the terminal-transport setting picks which.
const ptys = new Map<number, TerminalLink>()
const attachTargets = new Map<number, AttachTarget>()
const sizeClaims = new WeakMap<TerminalLink, () => Promise<void>>()
// The transport each window's renderer was told at load, so its terminal and
// its link agree until the window reloads.
type TerminalTransport = 'attach' | 'control'
const transportOf = new Map<number, TerminalTransport>()
const TRANSPORT_SETTING = 'terminal-transport'
function configuredTransport(): TerminalTransport {
  const forced = process.env.AICO_TERMINAL_TRANSPORT
  if (forced === 'attach' || forced === 'control') return forced
  return getSetting(TRANSPORT_SETTING) === 'attach' ? 'attach' : 'control'
}
// Windows Aico itself just resized (tiling, re-tiling, an agent's position):
// their next terminal resize claims the tmux size even while unfocused, or the
// grown window would show the old grid in a sea of dots until clicked.
const arrangedUntil = new Map<number, number>()
function setArrangedBounds(win: BrowserWindow, bounds: Electron.Rectangle): void {
  arrangedUntil.set(win.id, Date.now() + 3000)
  win.setBounds(bounds)
}
const ptyStartGenerations = new Map<number, number>()
const ptyRefreshes = new Map<
  number,
  { pty: TerminalLink | undefined; generation: number | undefined; request: Promise<void> }
>()
// BrowserWindow.id -> Tether session id. A window opened for a new session has
// no id until Tether creates it at the window's first grid size.
const widgetOf = new Map<number, string>()
const pendingCreates = new Map<number, { tool: string; projectId: string }>()
// Windows showing a pre-Tether A-Term session (`summitflow-<uuid>` on the
// default tmux server): attach-only, no generation, no view row, no actions.
const legacyOf = new Map<number, string>()
const LEGACY_ID_PREFIX = 'legacy:'
// Windows whose attach waits for Tether to come back, with their last grid.
const awaitingTether = new Map<number, PtySize>()
const boundsTimers = new Map<number, NodeJS.Timeout>()
// Sessions whose pane is being replaced (load-TUI, switch-project). Renderer
// input is dropped meanwhile, as before: the pane briefly shows Tether's
// containment gate and stale keystrokes must never reach it.
const replacing = new Set<string>()
const endsInFlight = new Map<string, Promise<void>>()
const selectionDeliveries = new Map<string, Promise<void>>()
let quitting = false
let stopEvents: (() => void) | null = null
let stopGuiChannel: (() => void) | null = null

// Eyes-follow-cursor: while any widget is unfocused, broadcast the global cursor
// position so those widgets' eyes can track it. One shared interval feeds every
// window; the focused window ignores it and stares ahead. Windows running the
// titlebar arcade also get the cursor (window coordinates, focused or not) while
// it is near their titlebar: the titlebar is the OS drag region, so the page
// itself never sees the pointer there. Runs only while someone needs it.
const blurredWins = new Set<number>()
// Window id -> titlebar arcade game, kept for the window's lifetime (or until
// the user cycles it), and the games that window has shown this cycle.
const arcadeOf = new Map<number, string>()
const arcadeShown = new Map<number, Set<string>>()
const arcadeNear = new Set<number>()
let cursorTimer: NodeJS.Timeout | undefined
let cursorPeriod = 0
let lastCursorPt: { x: number; y: number } | null = null
function pumpCursor(): void {
  const pt = screen.getCursorScreenPoint()
  if (lastCursorPt && pt.x === lastCursorPt.x && pt.y === lastCursorPt.y) return
  lastCursorPt = pt
  for (const id of blurredWins) {
    const win = BrowserWindow.fromId(id)
    if (win && !win.isDestroyed()) win.webContents.send('win:cursor', pt)
  }
  for (const id of arcadeOf.keys()) {
    const win = BrowserWindow.fromId(id)
    if (!win || win.isDestroyed() || !win.isVisible()) continue
    const near = cursorNearTitlebar(pt, win.getContentBounds())
    if (near) arcadeNear.add(id)
    else if (!arcadeNear.delete(id)) continue // already told it the cursor left
    win.webContents.send('arcade:cursor', near)
  }
}
function syncCursorPump(): void {
  lastCursorPt = null // a focus change always gets one fresh send
  const period = arcadeOf.size > 0 ? 100 : blurredWins.size > 0 ? 250 : 0
  if (period === cursorPeriod) return
  if (cursorTimer) clearInterval(cursorTimer)
  cursorTimer = period ? setInterval(pumpCursor, period) : undefined
  cursorPeriod = period
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
const dbPath = join(stateDir, 'aico.db')

const sidecarHost = process.env.AICO_SIDECAR_HOST ?? '127.0.0.1'
const sidecarPort = Number(process.env.AICO_SIDECAR_PORT ?? 8005)
let sidecar: Sidecar | null = null

const projects = new ProjectCatalog(
  () => tether.projects(),
  () => {
    pushTitles()
    syncTray()
  },
)

function logWidgetEvent(widgetId: string, event: string, data: Record<string, unknown>): void {
  // Reuse the sidecar's bounded, rotated per-widget JSONL implementation. The
  // console line remains authoritative if the optional sidecar is unavailable.
  void fetch(
    `http://${sidecarHost}:${sidecarPort}/widgets/${encodeURIComponent(widgetId)}/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, data }),
      // The sidecar is optional. A wedged loopback listener must not retain an
      // unbounded fetch while Aico is trying to reconcile or retire a workload.
      signal: AbortSignal.timeout(2_000),
    },
  ).catch(() => {})
}

// ---------------------------------------------------------------------------
// Gaze and layout (see gaze.ts): eyes that look at the other windows, and the
// window picture agents read before arranging them.

const eyeAnchors = new Map<number, Point>()
let gazeTimer: ReturnType<typeof setTimeout> | undefined
let layoutTimer: ReturnType<typeof setTimeout> | undefined
// A burst of changes (a drag, several sessions updating at once) writes once,
// 300 ms after it settles, but never later than 1 s after the first change.
let layoutDeadline = 0
const LAYOUT_PATH = join(
  process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
  'aico',
  'layout.json',
)
// Written into layout.json: readers check this process is still alive before
// trusting the file, since a SIGKILL or crash skips the unlink at quit.
const OWN_PROCESS = { pid: process.pid, startTime: ownStartTime() }

function aicoWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && widgetOf.has(w.id))
}

function faces(): Face[] {
  const focused = BrowserWindow.getFocusedWindow()
  return aicoWindows()
    .filter((w) => w.isVisible() && !w.isMinimized())
    .map((w) => {
      const b = w.getContentBounds()
      const a = eyeAnchors.get(w.id) ?? DEFAULT_EYE_ANCHOR
      return { winId: w.id, eye: { x: b.x + a.x, y: b.y + a.y }, focused: w === focused }
    })
}

let gazeScenesLogged = 0
function playGazeScene(): void {
  const scene = pickScene(faces(), Math.random)
  // The first few scenes after start go to the log, proof the director runs.
  if (scene.length && gazeScenesLogged < 3) {
    gazeScenesLogged++
    const who = (winId: number) => widgetOf.get(winId) ?? String(winId)
    console.log(`[aico:gaze] scene ${scene.map((g) => who(g.winId)).join(' ')}`)
  }
  for (const g of scene) {
    const win = BrowserWindow.fromId(g.winId)
    if (!win || win.isDestroyed()) continue
    win.webContents.send('eyes:look', {
      x: g.target.x,
      y: g.target.y,
      delay: g.delay,
      hold: g.hold,
    })
  }
}

function scheduleGaze(): void {
  const [lo, hi] = SCENE_EVERY_MS
  gazeTimer = setTimeout(
    () => {
      if (quitting) return
      playGazeScene()
      scheduleGaze()
    },
    lo + Math.random() * (hi - lo),
  )
}

function writeLayout(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const windows: LayoutWindow[] = []
  for (const w of aicoWindows()) {
    const id = widgetOf.get(w.id)
    if (!id) continue
    const descriptor = catalog.get(id)
    const bounds = w.getBounds()
    windows.push({
      id,
      name: descriptor ? sessionTitle(descriptor) : id,
      bounds,
      displayId: String(screen.getDisplayMatching(bounds).id),
      focused: w === focused,
      visible: w.isVisible(),
      minimized: w.isMinimized(),
      maximized: w.isMaximized(),
      coordinator: descriptor?.coordinator ?? false,
    })
  }
  const primary = screen.getPrimaryDisplay().id
  const displays = screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    primary: d.id === primary,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
  }))
  try {
    mkdirSync(join(LAYOUT_PATH, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${LAYOUT_PATH}.${process.pid}.tmp`
    writeFileSync(
      tmp,
      `${JSON.stringify(layoutSnapshot(displays, windows, OWN_PROCESS), null, 2)}\n`,
      {
        mode: 0o600,
      },
    )
    renameSync(tmp, LAYOUT_PATH)
  } catch (error) {
    console.warn('[aico:layout] write failed:', error instanceof Error ? error.message : error)
  }
}

// Windows opened or closed after startup re-tile their screen to the layout
// for the new count (see gaze.ts tileSlots). Restoring at launch keeps each
// window's remembered place.
let tilingLive = false
const NEW_WINDOW = '(new)'

function tileable(displayId: number): { id: string; bounds: Bounds }[] {
  return aicoWindows()
    .filter((w) => w.isVisible() && !w.isMinimized() && !w.isMaximized())
    .filter((w) => screen.getDisplayMatching(w.getBounds()).id === displayId)
    .map((w) => {
      const id = widgetOf.get(w.id) ?? ''
      return { id, bounds: w.getBounds(), coordinator: Boolean(id && catalog.get(id)?.coordinator) }
    })
    .filter((w) => w.id)
}

function applyMoves(moves: { id: string; bounds: Bounds }[]): void {
  for (const move of moves) {
    const win = windowForWidget(move.id)
    if (!win) continue
    const b = win.getBounds()
    if (
      b.x === move.bounds.x &&
      b.y === move.bounds.y &&
      b.width === move.bounds.width &&
      b.height === move.bounds.height
    )
      continue
    setArrangedBounds(win, move.bounds)
    persistBounds(win)
  }
}

/** Where a window opening now goes; moves the others to make room. */
function tileNewWindow(): Bounds {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const moves = arrange(display.workArea, tileable(display.id), NEW_WINDOW)
  applyMoves(moves.filter((m) => m.id !== NEW_WINDOW))
  return moves.find((m) => m.id === NEW_WINDOW)?.bounds ?? display.workArea
}

function retileDisplay(displayId: number): void {
  const display = screen.getAllDisplays().find((d) => d.id === displayId)
  if (display) applyMoves(arrange(display.workArea, tileable(display.id)))
}

// The coordinator mark lives on the Tether descriptor. Each window's last
// seen mark, so a change (from any app or `st aico widget coordinator`)
// re-tiles its screen; a window seen for the first time keeps its place.
const shownCoordinator = new Map<number, boolean>()

function retileOnCoordinatorChange(win: BrowserWindow, coordinator: boolean): void {
  const before = shownCoordinator.get(win.id)
  shownCoordinator.set(win.id, coordinator)
  if (before === undefined || before === coordinator || quitting) return
  retileDisplay(screen.getDisplayMatching(win.getBounds()).id)
  scheduleLayout()
}

/** Ask Tether to mark or unmark a coordinator; the change comes back as
 * `session.updated`. */
function requestCoordinator(id: string, coordinator: boolean): void {
  const descriptor = catalog.get(id)
  if (!descriptor) return
  tether.setCoordinator(id, descriptor.generation, coordinator).catch((error) => {
    writeNotice(
      windowForWidget(id),
      describeFailure('Could not change the coordinator mark', error),
      33,
    )
  })
}

function scheduleLayout(): void {
  // Before ready there is no screen to read (startup writes once when ready);
  // after quit starts, a late write would undo the unlink at quit.
  if (quitting || !app.isReady()) return
  const now = Date.now()
  if (layoutTimer) clearTimeout(layoutTimer)
  else layoutDeadline = now + 1000
  layoutTimer = setTimeout(
    () => {
      layoutTimer = undefined
      writeLayout()
    },
    Math.max(0, Math.min(300, layoutDeadline - now)),
  )
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

function writeNotice(win: BrowserWindow | undefined, message: string, color = 31): void {
  if (win && !win.isDestroyed())
    win.webContents.send('pty:data', `\r\n\u001b[${color}m${message}\u001b[0m\r\n`)
}

/** Plain words for a Tether refusal, shown in the session's own terminal. */
function describeFailure(action: string, error: unknown): string {
  if (error instanceof TetherUnavailable)
    return `${action}: Tether is not reachable. Your sessions keep running; Aico reconnects on its own.`
  if (error instanceof TetherError) {
    switch (error.code) {
      case 'admission_denied':
        return `${action}: deferred by host admission (${error.reason ?? 'not enough memory or too many agents'}). Nothing was started.`
      case 'linger_required':
        return `${action}: user linger is off, so a session would die on logout. Run: loginctl enable-linger`
      case 'stale_generation':
      case 'identity_changed':
        return `${action}: the session changed meanwhile. Nothing was applied; try again.`
      case 'busy':
        return `${action}: another change to this session is in progress. Try again shortly.`
      case 'workload_unavailable':
        return `${action}: the session is not running${error.reason ? ` (${error.reason})` : ''}.`
      case 'legacy_session':
        return `${action}: this session predates managed lifecycle and is kept read-only.`
      case 'outcome_uncertain':
        return `${action}: the outcome is unknown. Check the session before trying again.`
      default:
        return `${action}: ${error.reason ?? error.code}.`
    }
  }
  return `${action}: ${error instanceof Error ? error.message : String(error)}`
}

// ---------------------------------------------------------------------------
// Session catalog: mirrored from Tether, refreshed on events.

const refreshSessions = coalesceAsync(async () => {
  const mark = catalog.mark()
  const list = await tether.listSessions()
  const { gone } = catalog.replace(list, mark)
  for (const id of gone) attention.removed(id)
  for (const descriptor of catalog.list()) noteAgentState(descriptor)
  // A view whose session is absent from a complete list is closed but its row
  // is kept: only an explicit `session.ended` forgets a view. A wrong or empty
  // instance must never erase every saved window position.
  for (const id of gone) windowForWidget(id)?.destroy()
  if (!restored) {
    restored = true
    restoreOnLaunch()
  }
  pushTitles()
  syncTray()
})

function requestSessionRefresh(): void {
  void refreshSessions().catch((error) => {
    if (!(error instanceof TetherUnavailable)) console.warn('[aico] session refresh failed:', error)
  })
}

const refreshTools = coalesceAsync(async () => {
  tools = (await tether.tools()).items
    .filter((tool) => tool.enabled)
    .sort((a, b) => a.displayOrder - b.displayOrder)
  pushTitles()
  syncTray()
})

function sessionEnded(id: string, reason: string): void {
  const known = catalog.get(id)
  catalog.remove(id)
  attention.removed(id)
  // destroy() skips the 'close' event, so take the space it leaves here and
  // let neighbours grow into it once the window is gone.
  const win = windowForWidget(id)
  const freed = win?.isVisible() && !win.isMinimized() ? win.getBounds() : null
  win?.destroy()
  if (freed && !quitting) {
    const displayId = screen.getDisplayMatching(freed).id
    setImmediate(() => retileDisplay(displayId))
  }
  removeView(id)
  if (known) logWidgetEvent(id, 'lifecycle_retired', { session_id: known.ownershipId, reason })
  syncTray()
}

function onTetherEvent(event: TetherEvent): void {
  const id = typeof event.data.id === 'string' ? event.data.id : null
  switch (event.type) {
    case 'session.ended':
      if (id) sessionEnded(id, 'tether_event')
      requestSessionRefresh()
      break
    case 'session.created':
    case 'session.updated': {
      // Tether sends the descriptor with the event; an older Tether does not,
      // so fall back to re-listing.
      const snapshot = eventSession(event)
      if (!snapshot) {
        requestSessionRefresh()
        break
      }
      catalog.upsert(snapshot)
      noteAgentState(snapshot)
      pushTitles()
      syncTray()
      break
    }
    case 'root.updated':
      requestSessionRefresh()
      break
    case 'legacy.changed':
      if (Array.isArray(event.data.names)) closeEndedLegacyWindows(event.data.names)
      break
    case 'tools.changed':
      void refreshTools().catch(() => {})
      break
    case 'projects.changed':
      projects.invalidate()
      void projects.refresh()
      break
  }
}

async function checkTetherVersion(): Promise<void> {
  try {
    const version = await tether.version()
    if (compatibleVersion(version)) {
      tetherIncompatible = null
      return
    }
    tetherIncompatible = `Tether ${version.version} (API ${version.apiVersion}) is not compatible with this Aico`
  } catch (error) {
    if (error instanceof TetherUnavailable) return
    tetherIncompatible = 'Tether did not report a usable version'
  }
  console.error(`[aico:tether] ${tetherIncompatible}; session control is disabled`)
  stopEvents?.()
  stopGuiChannel?.()
  tetherConnected = false
  syncTray()
  dialog.showErrorBox(
    'Update Tether',
    `${tetherIncompatible}. Your sessions keep running. Install a current Tether (scripts/install.sh in the Tether repo) and restart Aico.`,
  )
}

function connectTether(): void {
  stopEvents = followEvents(tether, {
    onConnected: () => {
      const reconnected = !tetherConnected
      tetherConnected = true
      if (reconnected) {
        console.log(`[aico:tether] connected at ${tether.socketPath}`)
        void checkTetherVersion()
        void refreshTools().catch(() => {})
        void projects.refresh()
        resumeAwaitingAttaches()
      }
    },
    onDisconnected: (error) => {
      if (tetherConnected) console.warn('[aico:tether] event stream lost:', error)
      tetherConnected = false
      syncTray()
    },
    onResync: requestSessionRefresh,
    onEvent: onTetherEvent,
  })
  stopGuiChannel = holdGuiChannel(tether, applyGuiCommand, (message, error) =>
    error === undefined
      ? console.log(`[aico:gui] ${message}`)
      : console.warn(`[aico:gui] ${message}:`, error instanceof Error ? error.message : error),
  )
}

// ---------------------------------------------------------------------------
// GUI channel: Tether forwards show/position/title for views to this GUI after
// fencing the exact running generation under its lifecycle lock.

async function applyGuiCommand(command: GuiCommand): Promise<GuiVerdict> {
  if (quitting) return { applied: false, error: 'gui_unavailable' }
  let descriptor = catalog.get(command.sessionId)
  if (!descriptor || descriptor.generation !== command.generation) {
    await refreshSessions().catch(() => {})
    descriptor = catalog.get(command.sessionId)
  }
  if (!descriptor) return { applied: false, error: 'not_found' }
  if (descriptor.generation !== command.generation)
    return { applied: false, error: 'stale_generation' }
  const id = command.sessionId
  if (command.kind === 'show') {
    focusOrReopen(id)
  } else if (command.kind === 'position' && command.bounds) {
    const win = windowForWidget(id)
    if (win) {
      setArrangedBounds(win, command.bounds)
      persistBounds(win)
    } else {
      saveBounds(id, command.bounds, String(screen.getDisplayMatching(command.bounds).id))
    }
  } else if (command.kind === 'coordinator' && command.coordinator !== undefined) {
    // Tether records the mark once this view applied it and then sends
    // `session.updated`; show it now.
    catalog.upsert({ ...descriptor, coordinator: command.coordinator })
    pushTitles()
  } else if (command.kind === 'title' && command.label !== undefined) {
    // Tether renames the session once this view applied the title.
    catalog.upsert({ ...descriptor, name: command.label, label: command.label })
    pushTitles()
    syncTray()
  } else {
    return { applied: false, error: 'invalid_body' }
  }
  return { applied: true }
}

// ---------------------------------------------------------------------------
// Terminal byte path: one `tmux attach` PTY per window.

async function runTmux(
  target: AttachTarget,
  args: string[],
  maxBuffer = 1024 * 1024,
): Promise<string> {
  const { stdout } = await execFileAsync(target.argv[0], args, {
    env: attachEnvironment(process.env, target),
    timeout: TMUX_QUERY_TIMEOUT_MS,
    maxBuffer,
  })
  return stdout
}

function createRequest(pending: { tool: string; projectId: string }, size: PtySize) {
  if (pending.projectId === PERSONAL_WORKSPACE_ID) {
    const root = ensurePersonalWorkspaceRoot()
    return { tool: pending.tool, ...(root ? { projectRoot: root } : {}), size }
  }
  return { tool: pending.tool, projectId: pending.projectId, size }
}

function bindWindow(win: BrowserWindow, descriptor: SessionDescriptor): void {
  catalog.upsert(descriptor)
  widgetOf.set(win.id, descriptor.id)
  pendingCreates.delete(win.id)
  ensureView(descriptor.id, true)
  setOpen(descriptor.id, true)
  persistBounds(win)
}

async function startPty(win: BrowserWindow, size: PtySize): Promise<void> {
  const winId = win.id
  const generation = (ptyStartGenerations.get(winId) ?? 0) + 1
  ptyStartGenerations.set(winId, generation)
  const stillCurrent = () => !win.isDestroyed() && ptyStartGenerations.get(winId) === generation
  const existing = ptys.get(winId)
  if (existing) {
    existing.kill() // detaches the client; the tmux session persists
    ptys.delete(winId)
  }
  awaitingTether.delete(winId)

  const legacyName = legacyOf.get(winId)
  if (legacyName) {
    await startLegacyPty(win, legacyName, size, stillCurrent)
    return
  }

  let widgetId = widgetOf.get(winId)
  if (!widgetId) {
    const pending = pendingCreates.get(winId)
    if (!pending) return
    let created: SessionDescriptor
    try {
      created = await tether.createSession(createRequest(pending, size))
    } catch (error) {
      if (error instanceof TetherUnavailable) awaitingTether.set(winId, size)
      if (stillCurrent()) writeNotice(win, describeFailure('Could not start the session', error))
      return
    }
    if (win.isDestroyed()) {
      // The window closed during the create: the session keeps running and is
      // reopenable from the tray, exactly like a closed view.
      catalog.upsert(created)
      ensureView(created.id, false)
      syncTray()
      return
    }
    bindWindow(win, created)
    widgetId = created.id
    if (created.status !== 'running' && created.failure) {
      writeNotice(
        win,
        `Tether could not confirm the launch (${created.failure.reason ?? created.failure.code}).`,
        33,
      )
    }
    syncTray()
  }
  if (!stillCurrent()) return

  let target: AttachTarget
  try {
    target = await tether.attach(widgetId)
  } catch (error) {
    if (error instanceof TetherUnavailable) awaitingTether.set(winId, size)
    if (stillCurrent()) writeNotice(win, describeFailure('Could not attach', error))
    syncTray()
    return
  }
  if (!stillCurrent() || widgetOf.get(winId) !== widgetId) return
  const id = widgetId
  let pty: TerminalLink
  try {
    pty = openLink(winId, target, size)
  } catch (error) {
    writeNotice(win, describeFailure('Could not attach', error))
    return
  }
  if (!stillCurrent()) {
    pty.kill()
    return
  }
  const isCurrent = () =>
    !quitting &&
    !win.isDestroyed() &&
    widgetOf.get(winId) === id &&
    ptys.get(winId) === pty &&
    ptyStartGenerations.get(winId) === generation &&
    !replacing.has(id)
  // Desktop auto-resize: a window claims the shared tmux window size for its
  // own attached client (Tether's active-client resize claim) when it attaches,
  // gains focus, or is resized by Aico's tiling. Callers pick the moment.
  const claimSize = coalesceTrailingAsync(async () => {
    for (let attempt = 0; attempt < 4 && isCurrent(); attempt += 1) {
      const sessionGeneration = catalog.get(id)?.generation ?? target.generation
      try {
        const result = await tether.resizeClaim(id, sessionGeneration, pty.pid, pty.cols, pty.rows)
        if (result.applied) return
        if (result.reason === 'stale') await refreshSessions().catch(() => {})
        else if (result.reason !== 'client_not_attached' && result.reason !== 'tmux_unavailable')
          return
      } catch (error) {
        if (error instanceof TetherError && error.code === 'stale_generation') {
          await refreshSessions().catch(() => {})
          continue
        }
        if (!(error instanceof TetherUnavailable))
          console.warn(`[aico] resize claim failed widget=${id}:`, error)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  })
  sizeClaims.set(pty, claimSize)
  let claimAfterAttach = true
  pty.onData((data) => {
    if (claimAfterAttach && isCurrent()) {
      claimAfterAttach = false
      void claimSize()
    }
    if (!win.isDestroyed()) win.webContents.send('pty:data', data)
  })
  pty.onExit(() => {
    // Only clear the map if this is still the current pty: a prior pty killed on
    // re-attach can fire its exit after the replacement is stored.
    if (ptys.get(winId) === pty) {
      ptys.delete(winId)
      attachTargets.delete(winId)
      if (!quitting) requestSessionRefresh()
    }
  })
  ptys.set(winId, pty)
  attachTargets.set(winId, target)
  if (win.isFocused()) void claimSize()
}

/** The window's terminal link: a control-mode client when its renderer runs
 * the control transport, else a PTY running Tether's `tmux attach` argv. */
function openLink(winId: number, target: AttachTarget, size: PtySize): TerminalLink {
  const env = attachEnvironment(process.env, target)
  if (transportOf.get(winId) === 'control') return new ControlTerminal(target.argv, env, size)
  return spawn(target.argv[0], target.argv.slice(1), {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.env.HOME,
    env,
  })
}

/** Attach a legacy A-Term session. Tether gives no generation for it, so there
 * is no resize claim; the attach client sizes the window as tmux decides. */
async function startLegacyPty(
  win: BrowserWindow,
  name: string,
  size: PtySize,
  stillCurrent: () => boolean,
): Promise<void> {
  const winId = win.id
  let target: AttachTarget
  try {
    target = await tether.legacyAttach(name)
  } catch (error) {
    if (error instanceof TetherUnavailable) awaitingTether.set(winId, size)
    if (stillCurrent()) writeNotice(win, describeFailure('Could not attach', error))
    return
  }
  if (!stillCurrent()) return
  const pty = spawn(target.argv[0], target.argv.slice(1), {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.env.HOME,
    env: attachEnvironment(process.env, target),
  })
  pty.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send('pty:data', data)
  })
  pty.onExit(() => {
    if (ptys.get(winId) === pty) {
      ptys.delete(winId)
      attachTargets.delete(winId)
    }
  })
  ptys.set(winId, pty)
  attachTargets.set(winId, target)
}

function windowForLegacy(name: string): BrowserWindow | undefined {
  for (const [winId, legacy] of legacyOf) {
    if (legacy !== name) continue
    const win = BrowserWindow.fromId(winId)
    if (win && !win.isDestroyed()) return win
  }
  return undefined
}

/** Tether announced the legacy list; close windows whose session is gone,
 * as an ended Tether session closes its window. */
function closeEndedLegacyWindows(names: unknown[]): void {
  const live = new Set(names.filter((name): name is string => typeof name === 'string'))
  for (const [winId, name] of [...legacyOf]) {
    if (live.has(name)) continue
    const win = BrowserWindow.fromId(winId)
    if (win && !win.isDestroyed()) win.destroy()
  }
}

function openLegacySession(name: string): void {
  const existing = windowForLegacy(name)
  if (existing) {
    existing.show()
    existing.focus()
    return
  }
  const win = createWidgetWindow(null, null)
  legacyOf.set(win.id, name)
}

function resumeAwaitingAttaches(): void {
  for (const [winId, size] of awaitingTether) {
    const win = BrowserWindow.fromId(winId)
    awaitingTether.delete(winId)
    if (win && !win.isDestroyed()) {
      void startPty(win, size)
        .then(() => pushTitles())
        .catch((error) => console.error('[aico] PTY restart failed:', error))
    }
  }
}

function ptyFor(sender: Electron.WebContents): TerminalLink | undefined {
  const win = BrowserWindow.fromWebContents(sender)
  return win ? ptys.get(win.id) : undefined
}

/** The session a renderer's window shows, if any (untrusted IPC sender). */
function widgetIdFor(sender: Electron.WebContents): string | undefined {
  const win = BrowserWindow.fromWebContents(sender)
  return win ? widgetOf.get(win.id) : undefined
}

// ---------------------------------------------------------------------------
// Views: windows, bounds and restore.

// Persist a window's bounds (and which monitor it's on) so it restores in place.
function persistBounds(win: BrowserWindow): void {
  const widgetId = widgetOf.get(win.id)
  if (!widgetId || win.isDestroyed()) return
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
function placement(b: Bounds | null): Electron.BrowserWindowConstructorOptions {
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

/** One frameless widget window, bound to a session now (`view`) or once
 * Tether creates it (`pending`). */
function createWidgetWindow(
  view: ViewRow | null,
  pending: { tool: string; projectId: string } | null,
  restore = false,
): BrowserWindow {
  const row = { id: view?.id ?? 'new' }
  // Opened after startup: tile in on the screen under the pointer.
  const tiled = tilingLive && !(restore && view?.bounds) ? tileNewWindow() : null
  const win = new BrowserWindow({
    ...(tiled ?? placement(view?.bounds ?? null)),
    minWidth: 360,
    minHeight: 240,
    // Keep the frameless Lantern chrome, but make the native surface opaque.
    // These windows are often nearly full-height on a scaled 4K display; a
    // transparent surface made Chromium alpha-composite every terminal repaint
    // across tens of millions of pixels even though only the 8px rim used alpha.
    frame: false,
    transparent: false,
    backgroundColor: '#0B0D11',
    icon: join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      // Renderer runs in the OS sandbox. The preload is a pure contextBridge shim
      // (requires only electron's contextBridge/ipcRenderer, both available to a
      // sandboxed CommonJS preload), so nothing here needs Node at module scope.
      sandbox: true,
      // Keep Chromium's default background throttling. Three idle Aico windows
      // previously kept the GPU process near one-third of a core solely so the
      // cosmetic eyes could repaint at 60 ms while unfocused.
      backgroundThrottling: true,
    },
  })

  // Fixed local UI: no popups, and never navigate the frame away from the
  // renderer. Defense-in-depth so a renderer compromise can't open or redirect
  // to arbitrary content.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // The native textarea offers Chromium's spelling marks. Show its dictionary
  // suggestions on right-click; the terminal's separate right-click paste path
  // still runs because its xterm helper has spellcheck disabled.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable || !params.misspelledWord) return
    const suggestions = params.dictionarySuggestions.map((suggestion) => ({
      label: suggestion,
      click: () => win.webContents.replaceMisspelling(suggestion),
    }))
    if (suggestions.length === 0) return
    Menu.buildFromTemplate(suggestions).popup({ window: win })
  })
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    const log = details.level === 'error' ? console.error : console.warn
    log(
      `[aico:renderer] widget=${row.id} ${details.level} ` +
        `${details.sourceId || 'unknown'}:${details.lineNumber} ${details.message}`,
    )
  })
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        console.error(
          `[aico:renderer] widget=${row.id} load failed code=${errorCode} ` +
            `url=${validatedURL}: ${errorDescription}`,
        )
      }
    },
  )
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[aico:renderer] widget=${row.id} process gone reason=${details.reason} ` +
        `exit_code=${details.exitCode}`,
    )
  })

  const winId = win.id
  if (view) {
    widgetOf.set(winId, view.id)
    setOpen(view.id, true)
  } else if (pending) {
    pendingCreates.set(winId, pending)
  }

  win.webContents.on('did-finish-load', () => {
    refreshContextBadge(win)
    sendAttention(win)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Renderer toggles the focused/unfocused chrome state off these. Focus also
  // records this widget as the selection-grab target ("last-focused widget")
  // and claims the shared tmux window size for this view.
  win.on('focus', () => {
    const widgetId = widgetOf.get(win.id)
    lastFocusedAico = widgetId ?? lastFocusedAico
    if (widgetId) {
      attention.focused(widgetId)
      syncTray()
    }
    const pty = ptys.get(win.id)
    if (pty) void sizeClaims.get(pty)?.()
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
  for (const change of [
    'move',
    'resize',
    'focus',
    'blur',
    'show',
    'hide',
    'minimize',
    'restore',
  ] as const)
    win.on(change as 'move', scheduleLayout)
  let closingBounds: Bounds | null = null
  win.on('close', () => {
    persistBounds(win) // final flush while bounds are still valid
    closingBounds = win.isVisible() && !win.isMinimized() ? win.getBounds() : null
  })

  win.on('closed', () => {
    const widgetId = widgetOf.get(winId)
    const pty = ptys.get(winId)
    if (pty) {
      pty.kill() // detach; the session persists (close = keep, reopenable)
      ptys.delete(winId)
    }
    const timer = boundsTimers.get(winId)
    if (timer) {
      clearTimeout(timer)
      boundsTimers.delete(winId)
    }
    setWidgetActivity(winId, false)
    widgetOf.delete(winId)
    legacyOf.delete(winId)
    pendingCreates.delete(winId)
    awaitingTether.delete(winId)
    attachTargets.delete(winId)
    transportOf.delete(winId)
    ptyStartGenerations.delete(winId)
    blurredWins.delete(winId)
    arcadeOf.delete(winId)
    arcadeShown.delete(winId)
    arcadeNear.delete(winId)
    contextBadges.delete(winId)
    eyeAnchors.delete(winId)
    arrangedUntil.delete(winId)
    syncCursorPump()
    // Neighbours grow into the space this window leaves (not on quit: the
    // whole arrangement is coming back next launch).
    if (!quitting && closingBounds) retileDisplay(screen.getDisplayMatching(closingBounds).id)
    scheduleLayout()
    // On quit, leave `open` as-is so live views restore next launch; on an
    // explicit close, mark it closed (it moves to the tray's reopen list).
    if (!quitting && widgetId && getView(widgetId)) setOpen(widgetId, false)
    syncTray()
  })

  syncTray()
  return win
}

/** `restore`: reopen at the remembered place instead of tiling in. */
function openWidget(id: string, restore = false): void {
  createWidgetWindow(ensureView(id), null, restore)
}

// A new session is always an explicit (tool, workspace) pair. Its window opens
// at once; Tether creates the session at that window's first grid size.
function newWidget(tool: string, projectId: string): void {
  createWidgetWindow(null, { tool, projectId })
}

function focusOrReopen(id: string): void {
  const win = windowForWidget(id)
  if (win) {
    win.show()
    win.focus()
    return
  }
  openWidget(id)
}

function restoreOnLaunch(): void {
  const live = listViews().filter((view) => catalog.get(view.id))
  const open = live.filter((view) => view.open)
  if (open.length) {
    // Restore runs after the first session list, by which time tiling is
    // live; each window still goes back to where it was.
    for (const view of open) if (!windowForWidget(view.id)) openWidget(view.id, true)
  } else if (live.length && BrowserWindow.getAllWindows().length === 0) {
    openWidget(live[0].id) // nothing was open: bring back the oldest view
  }
}

// ---------------------------------------------------------------------------
// Session actions, all through Tether.

/** End a session: re-read its exact generation, then ask Tether to End it.
 * Repeat requests for the same session share one attempt. */
function endSession(id: string): Promise<void> {
  const current = endsInFlight.get(id)
  if (current) return current
  const attempt = (async () => {
    let descriptor: SessionDescriptor
    try {
      descriptor = await tether.getSession(id)
    } catch (error) {
      if (error instanceof TetherError && error.code === 'not_found') {
        sessionEnded(id, 'absent')
        return
      }
      throw error
    }
    try {
      await tether.end(id, descriptor.generation)
    } catch (error) {
      if (error instanceof TetherError && error.code === 'not_found') {
        sessionEnded(id, 'absent')
        return
      }
      throw error
    }
    sessionEnded(id, 'ended')
  })().finally(() => endsInFlight.delete(id))
  endsInFlight.set(id, attempt)
  return attempt
}

function discardWidget(id: string): void {
  void endSession(id).catch((error) => {
    console.error(`[aico] End failed widget=${id}:`, error)
    writeNotice(windowForWidget(id), describeFailure('End failed', error))
  })
}

async function confirmTrayDiscard(id: string): Promise<void> {
  const descriptor = catalog.get(id)
  if (!descriptor) return
  const response = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'End session'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'End session?',
    message: `End ${traySessionLabel(sessionTitle(descriptor), toolDisplayName(descriptor.tool, tools))}?`,
    detail: 'Tether stops only this session’s verified workload. This cannot be undone.',
  })
  if (response.response === 1) discardWidget(id)
}

/** Run a pane replacement with the generation Aico last read. Input is held
 * back until it settles; failures are shown in the session's terminal. */
function replacePane(
  id: string,
  action: string,
  run: (generation: string) => Promise<SessionDescriptor>,
): void {
  const descriptor = catalog.get(id)
  if (!descriptor || replacing.has(id)) return
  replacing.add(id)
  void run(descriptor.generation)
    .then((next) => catalog.upsert(next))
    .catch((error) => {
      console.warn(`[aico] ${action} failed widget=${id}:`, error)
      writeNotice(windowForWidget(id), describeFailure(action, error))
      requestSessionRefresh()
    })
    .finally(() => {
      replacing.delete(id)
      pushTitles()
      syncTray()
    })
}

function loadTui(id: string, slug: string): void {
  replacePane(id, 'Could not switch the tool', (generation) => tether.loadTui(id, generation, slug))
}

function switchProject(id: string, projectId: string): void {
  if (projectId === PERSONAL_WORKSPACE_ID) {
    // A directory, not a project: Tether switches to it by root.
    const root = ensurePersonalWorkspaceRoot()
    if (!root) {
      writeNotice(
        windowForWidget(id),
        `Could not switch the workspace: ${personalWorkspaceRoot()} could not be created.`,
        33,
      )
      return
    }
    replacePane(id, 'Could not switch the workspace', (generation) =>
      tether.switchProject(id, generation, { projectRoot: root }),
    )
    return
  }
  replacePane(id, 'Could not switch the workspace', (generation) =>
    tether.switchProject(id, generation, { projectId }),
  )
}

async function renameSession(id: string, name: unknown): Promise<void> {
  const descriptor = catalog.get(id)
  if (!descriptor) return
  const trimmed = typeof name === 'string' ? name.trim() : ''
  try {
    catalog.upsert(await tether.rename(id, descriptor.generation, trimmed || null))
  } catch (error) {
    writeNotice(windowForWidget(id), describeFailure('Could not rename', error), 33)
  }
  pushTitles()
  syncTray()
}

// ---------------------------------------------------------------------------
// Attention: flash a window and badge the tray when a session needs the owner
// (attention.ts); after 2 minutes unanswered, one Nightshift push to the phone.

const NIGHTSHIFT = join(homedir(), '.local/bin/nightshift')
/** a-term on the owner's phone; a tap on the push opens the waiting session there (Nightshift allowlists the origin). */
const ATERM_URL = (process.env.AICO_ATERM_URL ?? 'https://terminal.summitflow.dev').replace(
  /\/+$/,
  '',
)

const attention = new Attention({
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  isFocused: (id) => windowForWidget(id)?.isFocused() ?? false,
  flash: (id, on) => windowForWidget(id)?.flashFrame(on),
  needsYou: (on) => setNeedsYou(on),
  attend: (id, mode, stage) => {
    if (mode === 'none') attending.delete(id)
    else attending.set(id, { mode, stage })
    const win = windowForWidget(id)
    if (win) sendAttention(win)
  },
  push: (id) => {
    const descriptor = catalog.get(id)
    if (!descriptor) return
    const title = sessionTitle(descriptor)
    const agent = agentName(descriptor.stateSource, toolDisplayName(descriptor.tool, tools))
    // Nightshift's own Web Push to the owner's PWA. Nightshift keys repeats by
    // the --open link (one per session) and keeps them quiet for an hour.
    execFile(
      NIGHTSHIFT,
      [
        'push',
        pushBody(agent, title),
        '--title',
        'Aico: waiting for you',
        '--severity',
        'warning',
        '--open',
        `${ATERM_URL}/?session=${encodeURIComponent(id)}`,
      ],
      { timeout: 30_000 },
      (error, stdout) => {
        const output = String(stdout ?? '')
        const outcome = pushOutcome(error, output)
        console.log(pushEventLine(id, outcome))
        // The widget log records pushes that reached the phone, not Nightshift's dedupes.
        if (outcome.result === 'sent')
          logWidgetEvent(id, 'needs_you_push', {
            result: (output.trim().split('\n').pop() ?? '').trim().slice(0, 80),
          })
      },
    )
  },
})

/** What each waiting window shows on itself; resent when a window (re)loads. */
const attending = new Map<string, { mode: AttentionMode; stage: AttentionStage }>()

function sendAttention(win: BrowserWindow): void {
  const id = widgetOf.get(win.id)
  if (!id || win.isDestroyed()) return
  win.webContents.send('eyes:attention', attending.get(id) ?? { mode: 'none', stage: 'fresh' })
}

/** Every ~20 s, the other windows' eyes turn to each window waiting 2+ minutes. */
const URGENT_LOOK_EVERY_MS = 20_000
function lookAtUrgent(): void {
  const all = faces()
  for (const id of attention.urgent()) {
    const win = windowForWidget(id)
    const star = win && all.find((f) => f.winId === win.id)
    if (!star) continue
    for (const g of allLookAt(star, all, Math.random, false)) {
      BrowserWindow.fromId(g.winId)?.webContents.send('eyes:look', {
        x: g.target.x,
        y: g.target.y,
        delay: g.delay,
        hold: g.hold,
      })
    }
  }
}
setInterval(lookAtUrgent, URGENT_LOOK_EVERY_MS).unref()

function noteAgentState(descriptor: SessionDescriptor): void {
  attention.update(descriptor.id, descriptor.state ?? 'unknown', descriptor.stateAt ?? null)
}

// ---------------------------------------------------------------------------
// Tray and titlebars.

function showHub(): void {
  for (const win of BrowserWindow.getAllWindows()) win.show()
}

function tetherNotice(): string | null {
  if (tetherIncompatible) return `${tetherIncompatible}. Sessions keep running.`
  return tetherConnected ? null : 'Tether is not reachable. Sessions keep running.'
}

function trayTools(): { slug: string; label: string }[] {
  return tools.map((tool) => ({ slug: tool.slug, label: tool.name }))
}

function syncTray(): void {
  if (quitting) return
  const rows = groupRows(catalog.list(), attention, Date.now())
  const widgets: TrayWidget[] = rows.map(({ item: descriptor, group, detail }) => ({
    id: descriptor.id,
    label: traySessionLabel(sessionTitle(descriptor), toolDisplayName(descriptor.tool, tools)),
    open: windowForWidget(descriptor.id) !== undefined,
    group,
    detail,
  }))
  refreshTray(widgets, trayTools(), projects.list(), tetherNotice())
}

// No periodic rebuild: republishing the native menu collapses it while the
// owner is navigating it. Ages ("waiting 3m") refresh with the next real change
// and whenever an Aico window gains focus.

// Push titlebar info to every open window: the session's name (else its
// workspace, else Tether's label), plus its tool's mark and accent. Changes
// only on Tether events and Aico actions, so this is event-driven, not polled.
/** What each window's context badge last showed (`tool|state|detail`). */
const contextBadges = new Map<number, string>()

/** Show Tether's context-hook check as the titlebar badge, once per change. */
function pushContextBadge(win: BrowserWindow, descriptor: SessionDescriptor): void {
  const hook = descriptor.contextHook
  if (!hook) return
  const shown = contextBadges.get(win.id)
  // Not checked yet: keep a badge for the same tool, hide one for another tool.
  if (hook.state === 'unknown') {
    if (shown === undefined || shown.startsWith(`${hook.tool}|`)) return
    contextBadges.set(win.id, `${hook.tool}|unknown|`)
    win.webContents.send('context:mandate', {
      slug: hook.tool,
      state: hook.state,
      detail: hook.detail,
      applicable: false,
    })
    return
  }
  const key = `${hook.tool}|${hook.state}|${hook.detail}`
  if (shown === key) return
  contextBadges.set(win.id, key)
  win.webContents.send('context:mandate', {
    slug: hook.tool,
    state: hook.state,
    detail: hook.detail,
    applicable: hook.applicable,
  })
}

/** On window load, show the known badge and ask Tether to check again, as
 * Aico did before Tether owned launches. */
function refreshContextBadge(win: BrowserWindow): void {
  contextBadges.delete(win.id)
  const id = widgetOf.get(win.id)
  if (!id) return
  const known = catalog.get(id)
  if (known) pushContextBadge(win, known)
  tether
    .contextCheck(id)
    .then((hook) => {
      const latest = catalog.get(id)
      if (!hook || !latest || win.isDestroyed()) return
      catalog.upsert({ ...latest, contextHook: hook })
      pushContextBadge(win, catalog.get(id) ?? latest)
    })
    .catch(() => {})
}

function pushTitles(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const legacyName = legacyOf.get(win.id)
    if (legacyName) {
      const mark = toolMark('shell')
      win.webContents.send('win:title', {
        label: `A-Term ${legacyName.slice('summitflow-'.length, 'summitflow-'.length + 8)}`,
        name: null,
        icon: mark.icon,
        accent: mark.accent,
        tuiName: 'A-Term session',
        tuiSlug: 'shell',
        sessionId: legacyName,
        coordinator: false,
        chip: null,
      })
      continue
    }
    const widgetId = widgetOf.get(win.id)
    const descriptor = widgetId ? catalog.get(widgetId) : undefined
    if (!descriptor) continue
    const tool = tools.find((candidate) => candidate.slug === descriptor.tool)
    const mark = toolMark(descriptor.tool, tool?.color)
    pushContextBadge(win, descriptor)
    win.webContents.send('win:title', {
      label: sessionTitle(descriptor),
      name: descriptor.name, // prefills the rename input
      icon: mark.icon,
      accent: mark.accent,
      tuiName: tool?.name ?? descriptor.tool,
      tuiSlug: descriptor.tool,
      sessionId: descriptor.tmux.sessionId,
      coordinator: descriptor.coordinator ?? false,
      chip: coordinatorChip(descriptor),
    })
    retileOnCoordinatorChange(win, descriptor.coordinator ?? false)
  }
  // Names and coordinator marks are in layout.json too; agents read it right
  // after `root title`.
  scheduleLayout()
}

// ---------------------------------------------------------------------------
// Selection bus.

// The widget that should receive an indicated selection: the last-focused one
// if it's still open, else the most recently opened view.
function selectionTarget(): string | undefined {
  if (lastFocusedAico && windowForWidget(lastFocusedAico)) return lastFocusedAico
  const open = listViews().filter((view) => windowForWidget(view.id))
  return open.length ? open[open.length - 1].id : undefined
}

// Shared deliver path for every trigger (X11 hotkey + browser-driven SSE):
// type a compact reference at the target session's prompt through Tether (no
// Enter — the user adds their ask and submits), then flash a toast.
function deliverSelection(records: SelectionRecord[]): void {
  if (!records.some((record) => record?.kind && record.kind !== 'empty')) return
  const targetId = selectionTarget()
  if (!targetId) return
  const win = windowForWidget(targetId)
  if (selectionDeliveries.has(targetId)) {
    win?.webContents.send('selection:toast', {
      kind: 'Selection not inserted',
      snippet: 'Another selection is still being inserted. Try again.',
    })
    return
  }
  const descriptor = catalog.get(targetId)
  if (!win || !descriptor || replacing.has(targetId)) {
    win?.webContents.send('selection:toast', {
      kind: 'Session changing',
      snippet: 'Selection was not inserted while the terminal was being replaced.',
    })
    return
  }
  const request = deliverSelectionToSession(
    records,
    {
      isCurrent: () =>
        !quitting &&
        !win.isDestroyed() &&
        windowForWidget(targetId) === win &&
        catalog.get(targetId)?.generation === descriptor.generation,
      inject: async (text) => {
        await tether.inject(targetId, descriptor.generation, text, 'type')
      },
      delivered: (usable) => {
        win.show()
        win.focus()
        const head = usable[0]
        win.webContents.send('selection:toast', {
          kind: usable.length > 1 ? `${usable.length} items` : head.kind,
          snippet:
            usable.length > 1 ? usable.map((r) => r.snippet ?? '').join(' · ') : head.snippet,
        })
      },
    },
    (error) => {
      console.warn('[aico] selection insert failed:', error)
      win.webContents.send('selection:toast', {
        kind: 'Selection not inserted',
        snippet:
          error instanceof TetherError && error.code === 'stale_generation'
            ? 'The session changed. Try again.'
            : 'Tether could not insert the selection.',
      })
    },
  )
  selectionDeliveries.set(targetId, request)
  void request.finally(() => {
    if (selectionDeliveries.get(targetId) === request) selectionDeliveries.delete(targetId)
  })
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
  if (!sidecar?.ready) return // never take text from a process we did not start
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
// Only our own healthy sidecar is subscribed: if something else holds the port,
// its events must never be typed into an agent prompt. The sidecar pings every
// 15s, so a stream silent for SELECTION_EVENTS_IDLE_MS is half-open and is
// reconnected rather than silently dropping every later send.
const SELECTION_EVENTS_IDLE_MS = 45_000

function subscribeSelectionEvents(): void {
  selectionEvents = new AbortController()
  const url = `http://${sidecarHost}:${sidecarPort}/selection/events`
  void (async () => {
    while (!quitting) {
      const connection = new AbortController()
      const stopConnection = () => connection.abort()
      selectionEvents?.signal.addEventListener('abort', stopConnection)
      let idle: NodeJS.Timeout | undefined
      const armIdle = () => {
        clearTimeout(idle)
        idle = setTimeout(stopConnection, SELECTION_EVENTS_IDLE_MS)
      }
      try {
        if (!sidecar?.ready) throw new Error('sidecar not ready')
        armIdle()
        const res = await fetch(url, { signal: connection.signal })
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          armIdle()
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
      } finally {
        clearTimeout(idle)
        selectionEvents?.signal.removeEventListener('abort', stopConnection)
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
  const voice = voiceConnectSource(VOICE_WS_URL)
  const csp = contentSecurityPolicy(voice ? [voice] : [])
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

let signalQuitRequested = false
function requestGracefulSignalQuit(signal: NodeJS.Signals): void {
  if (signalQuitRequested) return
  signalQuitRequested = true
  console.log(`[aico:lifecycle] graceful ${signal} shutdown requested`)
  app.quit()
}
process.on('SIGTERM', () => requestGracefulSignalQuit('SIGTERM'))
process.on('SIGINT', () => requestGracefulSignalQuit('SIGINT'))

// Single-instance lock: a second launch must not spawn a duplicate (it would
// fight over the sidecar port :8005 and re-adopt the same widget catalog). The
// secondary quits immediately; the primary handles the desktop activation.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
const activationOnly = process.argv.includes('--aico-activate')
/** This process is the desktop runtime, not a launcher click or a duplicate. */
const runtimeOwner = gotSingleInstanceLock && !activationOnly

app.on('before-quit', () => {
  quitting = true
  stopEvents?.()
  stopGuiChannel?.()
  // A secondary instance (single-instance lock denied) quits before the app is
  // ready, where globalShortcut would throw; it never registered any anyway.
  if (app.isReady()) globalShortcut.unregisterAll()
  selectionEvents?.abort()
  sidecar?.stop()
  if (gazeTimer) clearTimeout(gazeTimer)
  if (layoutTimer) clearTimeout(layoutTimer)
  // Only the runtime that wrote layout.json removes it. A launcher click
  // (`--aico-activate`) quits through here too while the runtime keeps going.
  if (!runtimeOwner) return
  try {
    const written = JSON.parse(readFileSync(LAYOUT_PATH, 'utf8')) as { pid?: unknown }
    if (written.pid === process.pid) unlinkSync(LAYOUT_PATH) // no Aico running: no layout
  } catch {
    // Never written, or already gone.
  }
})

if (gotSingleInstanceLock && activationOnly) {
  // An activation helper must never become the desktop runtime if the managed
  // process exits between launcher verification and this lock request.
  app.exit(1)
} else if (!gotSingleInstanceLock) app.quit()

let activationReady = false
let activationPending = false
function activateAico(): void {
  if (!activationReady) {
    activationPending = true
    return
  }
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    for (const win of windows) win.show()
    windows[0].focus()
    return
  }
  const oldest = listViews().find((view) => catalog.get(view.id)) ?? catalog.list()[0]
  if (oldest) focusOrReopen(oldest.id)
  else newWidget('shell', PERSONAL_WORKSPACE_ID)
}

app.on('second-instance', activateAico)
app.on('activate', activateAico)

const activationReadyFile = process.env.AICO_ACTIVATION_READY_FILE
let activationIdentity: string | null = null
if (runtimeOwner && activationReadyFile) {
  try {
    // The start time disambiguates a reused PID without exposing an
    // application or agent environment variable.
    if (!OWN_PROCESS.startTime) throw new Error('missing process starttime')
    activationIdentity = `${process.pid} ${OWN_PROCESS.startTime}\n`
    const temporary = `${activationReadyFile}.tmp.${process.pid}`
    writeFileSync(temporary, activationIdentity, { mode: 0o600 })
    renameSync(temporary, activationReadyFile)
  } catch (error) {
    console.warn('[aico] could not publish activation readiness:', error)
  }
}
// The foreground runner registers its own PID, which exec hands to Electron.
// Clear it on a clean quit so the next start finds no stale pidfile.
const runtimePidFile = process.env.AICO_PIDFILE
app.on('before-quit', () => {
  if (runtimeOwner && runtimePidFile) removeOwnPidFile(runtimePidFile)
})

app.on('before-quit', () => {
  if (!activationReadyFile || !activationIdentity) return
  try {
    if (readFileSync(activationReadyFile, 'utf8') === activationIdentity)
      unlinkSync(activationReadyFile)
  } catch {
    // Startup may have failed before publication, or a restart replaced us.
  }
})

const SESSION_ID = /^[0-9a-f]{8}$/

const startup = app.whenReady().then(async () => {
  if (!runtimeOwner) return // no runtime initialization
  const { migrated } = initViews(dbPath)
  if (migrated) console.log(`[aico] copied ${migrated} window views from the pre-Tether catalog`)
  installContentSecurityPolicy()
  startSidecar()

  // No application menu — the Lantern chrome owns window controls, and the
  // default Edit menu's paste role mangled bracketed paste (handled in renderer).
  Menu.setApplicationMenu(null)

  ipcMain.on('pty:start', (event, size: PtySize) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      void startPty(win, clampSize(size))
        .then(() => pushTitles()) // fill the titlebar once the session is attached
        .catch((error) => console.error('[aico] PTY start failed:', error))
    }
  })

  ipcMain.on('pty:input', (event, data: unknown) => {
    if (typeof data !== 'string' || data.length === 0) return
    const widgetId = widgetIdFor(event.sender)
    if (!widgetId || replacing.has(widgetId)) return
    ptyFor(event.sender)?.write(data)
  })

  // Control-mode windows paste through tmux, which brackets the paste only
  // when the program asked for bracketed paste.
  ipcMain.on('pty:paste', (event, text: unknown) => {
    if (typeof text !== 'string' || text.length === 0) return
    const widgetId = widgetIdFor(event.sender)
    if (!widgetId || replacing.has(widgetId)) return
    const link = ptyFor(event.sender)
    if (link instanceof ControlTerminal) link.paste(text)
    else link?.write(text)
  })

  // The renderer asks once, before it starts its terminal; the answer holds
  // for this window until it reloads. Legacy A-Term sessions stay on attach.
  ipcMain.handle('terminal:transport', (event): TerminalTransport => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return 'attach'
    const transport = legacyOf.has(win.id) ? 'attach' : configuredTransport()
    transportOf.set(win.id, transport)
    return transport
  })
  ipcMain.handle('terminal:transport-setting', () => configuredTransport())
  // Switch every window: each reloads and reattaches on the other transport.
  // Sessions are untouched; only the views reattach.
  ipcMain.on('terminal:toggle-transport', () => {
    setSetting(TRANSPORT_SETTING, configuredTransport() === 'control' ? 'attach' : 'control')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && (widgetOf.has(win.id) || legacyOf.has(win.id)))
        win.webContents.reload()
    }
  })

  ipcMain.on('pty:resize', (event, size: PtySize) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const pty = ptyFor(event.sender)
    if (pty) {
      const { cols, rows } = clampSize(size)
      try {
        pty.resize(cols, rows)
        const arranged = win ? (arrangedUntil.get(win.id) ?? 0) > Date.now() : false
        if (win?.isFocused() || arranged) void sizeClaims.get(pty)?.()
      } catch (err) {
        console.warn('[aico] pty resize failed:', err)
      }
    }
  })

  // Manual Refresh: tmux holds the authoritative grid, so force every client
  // attached to this session to repaint from it — recovering an xterm view that
  // desynced (resize-reflow race, WebGL glitch, dropped/duped bytes).
  // Best-effort: a missing session or no clients is a no-op, never a crash.
  ipcMain.on('pty:refresh', (event, size?: PtySize) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    if (!win || !widgetId || quitting || replacing.has(widgetId)) return
    // Re-pair a drifted pty before the repaint: if the pty's size disagrees with
    // the renderer's live grid, tmux paints for the wrong geometry.
    const pty = ptyFor(event.sender)
    if (pty && size) {
      const { cols, rows } = clampSize(size)
      if (pty.cols !== cols || pty.rows !== rows) {
        console.warn(
          `[aico] refresh: size desync (pty ${pty.cols}x${pty.rows}, term ${cols}x${rows}); re-pairing`,
        )
        try {
          pty.resize(cols, rows)
        } catch (err) {
          console.warn('[aico] pty resize failed:', err)
        }
      }
    }
    const generation = ptyStartGenerations.get(win.id)
    const pending = ptyRefreshes.get(win.id)
    if (pending && pending.pty === pty && pending.generation === generation) return
    const target = attachTargets.get(win.id)
    const attached = target ? attachSocketTarget(target.argv) : null
    const isCurrent = () =>
      !quitting &&
      !win.isDestroyed() &&
      widgetOf.get(win.id) === widgetId &&
      ptys.get(win.id) === pty &&
      ptyStartGenerations.get(win.id) === generation &&
      !replacing.has(widgetId)
    const request = (async () => {
      if (pty) await sizeClaims.get(pty)?.()
      if (pty instanceof ControlTerminal) {
        if (isCurrent()) pty.reseed()
        return
      }
      if (target && attached && isCurrent())
        await refreshAttachedClients(attached, (args) => runTmux(target, args), isCurrent)
    })()
    ptyRefreshes.set(win.id, { pty, generation, request })
    void request
      .catch((err) => console.warn('[aico] pty refresh failed:', err))
      .finally(() => {
        if (ptyRefreshes.get(win.id)?.request === request) ptyRefreshes.delete(win.id)
      })
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:has-image', () => !clipboard.readImage().isEmpty())
  ipcMain.on('link:open', (_event, url: unknown) => {
    if (typeof url !== 'string' || url.length > 8192) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        void shell.openExternal(parsed.toString())
    } catch {
      // Not a URL: ignore.
    }
  })
  ipcMain.on('clipboard:write', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  ipcMain.handle('session:diagnostics', async (event) => {
    const widgetId = widgetIdFor(event.sender)
    if (!widgetId) return { capturedAt: new Date().toISOString(), error: 'no session' }
    try {
      return await tether.diagnostics(widgetId)
    } catch (error) {
      return {
        capturedAt: new Date().toISOString(),
        sessionId: widgetId,
        error: describeFailure('Diagnostics unavailable', error),
      }
    }
  })

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
  ipcMain.on('eyes:anchor', (event, pt: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const p = pt as Partial<Point> | null
    if (!win || typeof p?.x !== 'number' || typeof p.y !== 'number') return
    if (
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      Math.abs(p.x) > 4000 ||
      Math.abs(p.y) > 4000
    )
      return
    eyeAnchors.set(win.id, { x: Math.round(p.x), y: Math.round(p.y) })
  })
  ipcMain.on('win:set-bounds', (event, b: unknown) => {
    const bounds = parseBoundsRequest(b)
    if (bounds) BrowserWindow.fromWebContents(event.sender)?.setBounds(bounds)
  })
  // Titlebar arcade on or off, for every window (one row in aico.db). Off, no
  // window runs a game and the cursor pump stops for them.
  const arcadeOn = (): boolean => getSetting('arcade') !== 'off'
  ipcMain.handle('arcade:enabled', () => arcadeOn())
  ipcMain.on('arcade:toggle', () => {
    const on = !arcadeOn()
    setSetting('arcade', on ? 'on' : 'off')
    if (!on) {
      arcadeOf.clear()
      arcadeShown.clear()
      arcadeNear.clear()
      syncCursorPump()
    }
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('arcade:enabled', on)
  })
  // Titlebar arcade: the renderer lists the games it ships; main picks one this
  // window keeps (reloads included) until it closes.
  ipcMain.handle('arcade:assign', (event, keys: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const known = parseArcadeKeys(keys)
    if (!win || !known || !arcadeOn()) return null
    const current = arcadeOf.get(win.id)
    if (current && known.includes(current)) return current
    arcadeOf.delete(win.id)
    const key = pickArcade(known, arcadeOf.values())
    if (key) {
      arcadeOf.set(win.id, key)
      arcadeShown.set(win.id, new Set([key]))
    }
    syncCursorPump()
    return key
  })
  // "Choose game" from the lantern menu: this game, in this window. Picking one
  // while the games are off turns them back on.
  ipcMain.handle('arcade:pick', (event, pick: unknown, keys: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const known = parseArcadeKeys(keys)
    if (!win || !known || typeof pick !== 'string' || !known.includes(pick)) return null
    arcadeOf.set(win.id, pick)
    arcadeShown.set(win.id, new Set([...(arcadeShown.get(win.id) ?? []), pick]))
    syncCursorPump()
    if (!arcadeOn()) {
      setSetting('arcade', 'on')
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('arcade:enabled', true)
    }
    return pick
  })
  // "Next game" from the lantern menu: another game this window hasn't shown
  // yet and no other window is showing (while one is free).
  ipcMain.handle('arcade:next', (event, keys: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const known = parseArcadeKeys(keys)
    if (!win || !known || !arcadeOn()) return null
    const current = arcadeOf.get(win.id)
    const others = [...arcadeOf].filter(([id]) => id !== win.id).map(([, k]) => k)
    const shown = arcadeShown.get(win.id) ?? new Set(current ? [current] : [])
    const next = nextArcade(known, current, others, shown)
    if (!next.key) return null
    arcadeOf.set(win.id, next.key)
    arcadeShown.set(win.id, next.shown)
    syncCursorPump()
    return next.key
  })
  ipcMain.on('win:thinking', (event, on: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) setWidgetActivity(win.id, on)
  })

  // Control-surface actions: same handlers the tray uses. A new session is
  // always an explicit (tool, workspace) pair from the picker — both required,
  // both checked (untrusted renderer input), so a malformed call is ignored.
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

  // End this session from the widget itself: Tether ends the workload and the
  // window closes once it has.
  ipcMain.handle('session:end-self', async (event) => {
    const id = widgetIdFor(event.sender)
    if (!id) throw new Error('Session view is unavailable')
    try {
      await endSession(id)
    } catch (error) {
      throw new Error(describeFailure('End failed', error))
    }
  })

  ipcMain.on('widget:toggle-coordinator', (event) => {
    const id = widgetIdFor(event.sender)
    if (id) requestCoordinator(id, !catalog.get(id)?.coordinator)
  })

  // Replace the focused session's running tool with another (no new window).
  ipcMain.on('widget:load-tui', (event, slug?: unknown) => {
    const id = widgetIdFor(event.sender)
    if (id && typeof slug === 'string' && slug) loadTui(id, slug)
  })

  // Move the focused session to another workspace: Tether respawns its pane
  // there with the same tool.
  ipcMain.on('widget:switch-project', (event, projectId?: unknown) => {
    const id = widgetIdFor(event.sender)
    if (id && typeof projectId === 'string' && projectId) switchProject(id, projectId)
  })

  // Rename from the titlebar. Empty clears it back to Tether's default label.
  ipcMain.on('widget:set-name', (event, name: unknown) => {
    const id = widgetIdFor(event.sender)
    if (id) void renameSession(id, name)
  })

  // Enabled tools from Tether's registry, in its order, with Aico's marks.
  ipcMain.handle('tui:list', async () => {
    if (!tools.length) await refreshTools().catch(() => {})
    return tools.map((tool) => {
      const mark = toolMark(tool.slug, tool.color)
      return { slug: tool.slug, displayName: tool.name, accent: mark.accent, icon: mark.icon }
    })
  })

  // Workspace catalog for "Open workspace ▸": Personal Workspace plus Tether's
  // projects. Awaits a stale refresh so the first menu is complete.
  ipcMain.handle('project:list', () => projects.listFresh())

  // Every running Tether session, whichever app created it, plus A-Term's
  // pre-Tether sessions, which Tether lists for attach only.
  ipcMain.handle('session:list-openable', async () => {
    await refreshSessions()
    const legacy = await tether.legacySessions().catch(() => [])
    const sessions = catalog
      .list()
      .filter((descriptor) => descriptor.status === 'running' || descriptor.status === 'legacy')
      .map((descriptor) => ({
        id: descriptor.id,
        origin: descriptor.origin,
        label: sessionTitle(descriptor),
        project: projects.nameFor(descriptor.projectId, descriptor.projectRoot),
        tool: toolDisplayName(descriptor.tool, tools),
        status: 'running' as const,
        locallyOpen: Boolean(windowForWidget(descriptor.id)),
      }))
    return [
      ...sessions,
      ...legacy.map((item) => ({
        id: `${LEGACY_ID_PREFIX}${item.name}`,
        origin: 'a-term' as const,
        label: `A-Term ${item.name.slice('summitflow-'.length, 'summitflow-'.length + 8)}`,
        project: null,
        tool: 'legacy session',
        status: 'running' as const,
        locallyOpen: Boolean(windowForLegacy(item.name)),
      })),
    ]
  })
  ipcMain.handle('session:open', async (_event, id: unknown) => {
    if (typeof id === 'string' && id.startsWith(LEGACY_ID_PREFIX)) {
      const name = id.slice(LEGACY_ID_PREFIX.length)
      if (!LEGACY_SESSION_NAME.test(name)) throw new Error('Invalid session')
      const listed = await tether.legacySessions()
      if (!listed.some((item) => item.name === name)) throw new Error('Session is unavailable')
      openLegacySession(name)
      return
    }
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('Invalid session')
    const descriptor = await tether.getSession(id)
    if (descriptor.status !== 'running' && descriptor.status !== 'legacy')
      throw new Error('Session is unavailable')
    catalog.upsert(descriptor)
    focusOrReopen(id)
  })

  // Global pinned-action set (one row in aico.db, shared across widgets). A
  // setPins from any widget persists and broadcasts so every cluster updates.
  ipcMain.handle('settings:get-pins', () => {
    const raw = getSetting('pins')
    if (raw == null) return null
    try {
      return parsePins(JSON.parse(raw))
    } catch {
      return null
    }
  })
  ipcMain.on('settings:set-pins', (_event, input: unknown) => {
    const ids = parsePins(input)
    if (!ids) return
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
      onDiscard: (id) => void confirmTrayDiscard(id),
      onNewWidget: newWidget,
      onRefreshSessions: () => {
        projects.invalidate()
        requestSessionRefresh()
        void refreshTools().catch(() => {})
      },
      onHubView: showHub,
    },
    trayTools(),
    projects.list(),
  )
  scheduleGaze()
  scheduleLayout()
  tilingLive = true
  // Returning to any Aico window refreshes the native tray catalog as well.
  // Linux does not provide a reliable async hook before its cached tray menu opens.
  app.on('browser-window-focus', syncTray)
  app.on('activate', syncTray)

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
  // getUserMedia is denied by default. Bind the grant to a currently catalogued
  // Aico widget's main renderer document and to audio-only requests; another
  // webContents, iframe, navigated document, or video request is rejected.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, cb, details) => {
    const win = BrowserWindow.fromWebContents(webContents)
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    cb(
      allowTrustedAudioMedia({
        permission,
        trustedRenderer: win !== null && widgetOf.has(win.id),
        currentUrl: webContents.getURL(),
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        mediaTypes,
      }),
    )
  })
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      const win = webContents ? BrowserWindow.fromWebContents(webContents) : null
      return allowTrustedAudioMedia({
        permission,
        trustedRenderer: win !== null && widgetOf.has(win.id),
        currentUrl: webContents?.getURL() ?? '',
        requestingUrl: details.requestingUrl ?? requestingOrigin,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType ? [details.mediaType] : undefined,
      })
    },
  )
  const voiceHotkeyOk = globalShortcut.register(VOICE_PTT_HOTKEY, toggleVoice)
  console.log(
    `[aico] voice PTT hotkey ${VOICE_PTT_HOTKEY}: ${
      voiceHotkeyOk ? 'registered' : 'unavailable (Wayland? bind a GNOME shortcut to toggle voice)'
    }`,
  )

  // Browser-driven sends (and any CLI POST to /selection/send) arrive here.
  subscribeSelectionEvents()

  connectTether()
  syncTray()
  activationReady = true
  if (activationPending) {
    activationPending = false
    activateAico()
  }
})
startup.catch(failStartup)

/**
 * Startup that throws part-way leaves no tray, IPC or control socket while the
 * process still holds the single-instance lock, so every later launch would be
 * swallowed by `second-instance`. Say why and exit so the next launch starts
 * clean; durable tmux sessions are untouched.
 */
function failStartup(error: unknown): void {
  console.error('[aico] startup failed:', error)
  try {
    dialog.showErrorBox(
      'Aico could not start',
      `${error instanceof Error ? error.message : String(error)}\n\nYour sessions are still running. Fix the cause and open Aico again.`,
    )
  } finally {
    app.exit(1)
  }
}

app.on('window-all-closed', () => {
  // Aico lives in the tray after the last widget closes; Quit (tray) exits.
})
