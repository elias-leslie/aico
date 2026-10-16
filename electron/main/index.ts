import { execFile } from 'node:child_process'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
  pushBody,
  pushEventLine,
  pushOutcome,
} from './attention'
import { readConfig } from './config'
import { contentSecurityPolicy, voiceConnectSource } from './csp'
import {
  allLookAt,
  DEFAULT_EYE_ANCHOR,
  type Face,
  type Point,
  pickScene,
  SCENE_EVERY_MS,
} from './gaze'
import { createGuiChannel } from './gui-channel'
import { parseBoundsRequest, parsePins } from './ipc-validation'
import { createLifecycle } from './lifecycle'
import { allowTrustedAudioMedia } from './media-permission'
import { ownStartTime, removeOwnPidFile } from './process-identity'
import { ensurePersonalWorkspaceRoot, ProjectCatalog, personalWorkspaceRoot } from './project'
import { parseSse, type SelectionRecord } from './selection'
import { deliverSelectionToSession } from './selection-delivery'
import { createSessionActions } from './session-actions'
import {
  createSessionCatalog,
  type SessionCatalog,
  sessionTitle,
  toolDisplayName,
} from './session-catalog'
import { bundledSidecar, Sidecar } from './sidecar'
import { createTerminal } from './terminal'
import {
  type SessionDescriptor,
  TetherClient,
  TetherError,
  tetherSocketPath,
} from './tether-client'
import { createTetherLink } from './tether-link'
import { ControlTerminal } from './tmux-control'
import { createTray, refreshTray, setNeedsYou, setWidgetActivity } from './tray'
import {
  ensureView,
  getSetting,
  getView,
  initViews,
  listViews,
  removeView,
  saveBounds,
  setOpen,
  setSetting,
} from './views'
import { createWindowChrome } from './window-chrome'
import { createWindowLayout } from './window-layout'
import { WindowRegistry } from './window-registry'
import { createWindows } from './windows'

const config = readConfig(process.env, homedir(), process.getuid?.())
// The single-instance lock and the process listeners, before anything else.
const lifecycle = createLifecycle({
  app,
  dialog,
  argv: process.argv,
  config,
  onSignal: (signal, listener) => {
    process.on(signal, listener)
  },
  startTime: ownStartTime,
  removeOwnPidFile,
  fs: { readFileSync, writeFileSync, renameSync, unlinkSync },
})

// Tether owns every session: tmux servers, panes, agent launch, End and the
// root contract. Aico shows sessions in windows (views) and keeps their
// geometry and its settings. A window's PTY runs the exact `tmux attach` argv
// Tether hands out; killing that PTY only detaches, so the session survives
// close, reload and Aico restarts.
const tether = new TetherClient(tetherSocketPath())
const catalog: SessionCatalog = createSessionCatalog()

// Which window shows which session, where windows go, and the windows
// themselves. The hooks run, in this order, what other parts of index.ts do
// when a window loads, focuses, blurs or goes away.
const registry = new WindowRegistry(BrowserWindow)
const layout = createWindowLayout({
  registry,
  screen,
  focusedWindow: () => BrowserWindow.getFocusedWindow(),
  isCoordinator: (id) => catalog.get(id)?.coordinator ?? false,
  sessionName: (id) => {
    const descriptor = catalog.get(id)
    return descriptor ? sessionTitle(descriptor) : id
  },
  saveBounds,
  isReady: () => app.isReady(),
  isQuitting: lifecycle.isQuitting,
  path: config.layoutPath,
  owner: lifecycle.ownProcess,
})
const windows = createWindows({
  registry,
  layout,
  views: { ensureView, setOpen, getView, listViews },
  screen,
  isLive: (id) => Boolean(catalog.get(id)),
  upsert: (descriptor) => catalog.upsert(descriptor),
  catalogList: () => catalog.list(),
  isQuitting: lifecycle.isQuitting,
  rendererUrl: config.rendererUrl,
  BrowserWindow,
  Menu,
  hooks: {
    loaded: (win) => {
      chrome.refreshContextBadge(win)
      sendAttention(win)
    },
    focused: (win, widgetId) => {
      lastFocusedAico = widgetId ?? lastFocusedAico
      if (widgetId) {
        attention.focused(widgetId)
        chrome.syncTray()
      }
      terminal.claimSize(win.id)
      blurredWins.delete(win.id)
      syncCursorPump()
    },
    blurred: (win) => {
      blurredWins.add(win.id)
      syncCursorPump()
    },
    disposing: (winId) => {
      // Terminal: detach first; the session persists (close = keep, reopenable).
      terminal.forget(winId)
      // Titlebar and tray.
      chrome.forget(winId)
      // Eyes and arcade.
      blurredWins.delete(winId)
      arcadeOf.delete(winId)
      arcadeShown.delete(winId)
      arcadeNear.delete(winId)
      eyeAnchors.delete(winId)
      syncCursorPump()
      layout.forget(winId)
    },
    changed: () => chrome.syncTray(),
  },
})

const selectionDeliveries = new Map<string, Promise<void>>()

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

let sidecar: Sidecar | null = null

const projects = new ProjectCatalog(
  () => tether.projects(),
  () => {
    chrome.pushTitles()
    chrome.syncTray()
  },
)

// The live connection to Tether and the session and tool mirror. The hooks
// run, in this order, what the rest of Aico does when the catalog changes.
const link = createTetherLink({
  tether,
  catalog,
  projects,
  dialog,
  hooks: {
    agentState: (descriptor) => noteAgentState(descriptor),
    removed: (id) => attention.removed(id),
    destroyWindow: (id) => windows.destroyFor(id),
    closeEnded: (id) => windows.closeEnded(id),
    retired: (id, known, reason) => {
      removeView(id)
      if (known) logWidgetEvent(id, 'lifecycle_retired', { session_id: known.ownershipId, reason })
    },
    firstList: () => windows.restoreOnLaunch(),
    titles: () => chrome.pushTitles(),
    tray: () => chrome.syncTray(),
    connected: () => terminal.resumeAwaiting(),
    legacyChanged: (names) => windows.closeEndedLegacy(names),
  },
})

function logWidgetEvent(widgetId: string, event: string, data: Record<string, unknown>): void {
  // Reuse the sidecar's bounded, rotated per-widget JSONL implementation. The
  // console line remains authoritative if the optional sidecar is unavailable.
  void fetch(
    `http://${config.sidecarHost}:${config.sidecarPort}/widgets/${encodeURIComponent(widgetId)}/events`,
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
// Gaze (see gaze.ts): eyes that look at the other windows.

const eyeAnchors = new Map<number, Point>()
let gazeTimer: ReturnType<typeof setTimeout> | undefined

function faces(): Face[] {
  const focused = BrowserWindow.getFocusedWindow()
  return registry
    .sessionWindows()
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
    const who = (winId: number) => registry.sessionOf(winId) ?? String(winId)
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
      if (lifecycle.isQuitting()) return
      playGazeScene()
      scheduleGaze()
    },
    lo + Math.random() * (hi - lo),
  )
}

// ---------------------------------------------------------------------------
// Attention: flash a window and badge the tray when a session needs the owner
// (attention.ts); after 2 minutes unanswered, one Nightshift push to the phone.

const attention = new Attention({
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  isFocused: (id) => registry.forSession(id)?.isFocused() ?? false,
  flash: (id, on) => registry.forSession(id)?.flashFrame(on),
  needsYou: (on) => setNeedsYou(on),
  attend: (id, mode, stage) => {
    if (mode === 'none') attending.delete(id)
    else attending.set(id, { mode, stage })
    const win = registry.forSession(id)
    if (win) sendAttention(win)
  },
  push: (id) => {
    const descriptor = catalog.get(id)
    if (!descriptor) return
    const title = sessionTitle(descriptor)
    const agent = agentName(descriptor.stateSource, toolDisplayName(descriptor.tool, link.tools()))
    // Nightshift's own Web Push to the owner's PWA. Nightshift keys repeats by
    // the --open link (one per session) and keeps them quiet for an hour.
    execFile(
      config.nightshift,
      [
        'push',
        pushBody(agent, title),
        '--title',
        'Aico: waiting for you',
        '--severity',
        'warning',
        '--open',
        `${config.atermUrl}/?session=${encodeURIComponent(id)}`,
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
  const id = registry.sessionOf(win.id)
  if (!id || win.isDestroyed()) return
  win.webContents.send('eyes:attention', attending.get(id) ?? { mode: 'none', stage: 'fresh' })
}

/** Every ~20 s, the other windows' eyes turn to each window waiting 2+ minutes. */
const URGENT_LOOK_EVERY_MS = 20_000
function lookAtUrgent(): void {
  const all = faces()
  for (const id of attention.urgent()) {
    const win = registry.forSession(id)
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

const chrome = createWindowChrome({
  registry,
  allWindows: () => BrowserWindow.getAllWindows(),
  catalog,
  tools: link.tools,
  notice: link.notice,
  projects,
  attention,
  layout,
  contextCheck: (id) => tether.contextCheck(id),
  isQuitting: lifecycle.isQuitting,
  tray: { createTray, refreshTray, setWidgetActivity },
})

const applyGuiCommand = createGuiChannel({
  isQuitting: lifecycle.isQuitting,
  catalog,
  refresh: link.refresh,
  focusOrReopen: windows.focusOrReopen,
  forSession: registry.forSession,
  arrange: layout.arrange,
  saveBounds,
  displayIdFor: (bounds) => String(screen.getDisplayMatching(bounds).id),
  titles: () => chrome.pushTitles(),
  tray: () => chrome.syncTray(),
})

// What the owner can do to a session, all through Tether.
const sessions = createSessionActions({
  tether,
  catalog,
  link,
  registry,
  windows,
  projects,
  titles: () => chrome.pushTitles(),
  tray: () => chrome.syncTray(),
  dialog,
  personalWorkspace: { ensureRoot: ensurePersonalWorkspaceRoot, root: personalWorkspaceRoot },
})

// Terminal byte path: one terminal link per window, attach or control mode.
const terminal = createTerminal({
  tether,
  catalog,
  registry,
  windowById: (id) => BrowserWindow.fromId(id),
  allWindows: () => BrowserWindow.getAllWindows(),
  bind: windows.bind,
  ensureView,
  refresh: link.refresh,
  requestRefresh: link.requestRefresh,
  isReplacing: sessions.isReplacing,
  recentlyArranged: layout.recentlyArranged,
  titles: () => chrome.pushTitles(),
  tray: () => chrome.syncTray(),
  getSetting,
  setSetting,
  forcedTransport: config.forcedTransport,
  spawnPty: spawn,
  controlTerminal: (argv, env, size) => new ControlTerminal(argv, env, size),
  execFileAsync: promisify(execFile),
  ensurePersonalWorkspaceRoot,
  isQuitting: lifecycle.isQuitting,
  env: process.env,
})

// ---------------------------------------------------------------------------
// Selection bus.

// The widget that should receive an indicated selection: the last-focused one
// if it's still open, else the most recently opened view.
function selectionTarget(): string | undefined {
  if (lastFocusedAico && registry.forSession(lastFocusedAico)) return lastFocusedAico
  const open = listViews().filter((view) => registry.forSession(view.id))
  return open.length ? open[open.length - 1].id : undefined
}

// Shared deliver path for every trigger (X11 hotkey + browser-driven SSE):
// type a compact reference at the target session's prompt through Tether (no
// Enter — the user adds their ask and submits), then flash a toast.
function deliverSelection(records: SelectionRecord[]): void {
  if (!records.some((record) => record?.kind && record.kind !== 'empty')) return
  const targetId = selectionTarget()
  if (!targetId) return
  const win = registry.forSession(targetId)
  if (selectionDeliveries.has(targetId)) {
    win?.webContents.send('selection:toast', {
      kind: 'Selection not inserted',
      snippet: 'Another selection is still being inserted. Try again.',
    })
    return
  }
  const descriptor = catalog.get(targetId)
  if (!win || !descriptor || sessions.isReplacing(targetId)) {
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
        !lifecycle.isQuitting() &&
        !win.isDestroyed() &&
        registry.forSession(targetId) === win &&
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
    focused && registry.hasSession(focused.id)
      ? focused
      : registry.forSession(selectionTarget() ?? '')
  win?.webContents.send('voice:toggle')
}

// "Indicate" hotkey (X11 fallback for non-web sources): harvest the freshest
// capture from the bus and deliver it. Browser sends arrive via SSE instead.
async function selectionGrab(): Promise<void> {
  if (!sidecar?.ready) return // never take text from a process we did not start
  try {
    const res = await fetch(`http://${config.sidecarHost}:${config.sidecarPort}/selection/current`)
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
  const url = `http://${config.sidecarHost}:${config.sidecarPort}/selection/events`
  void (async () => {
    while (!lifecycle.isQuitting()) {
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
        if (lifecycle.isQuitting() || selectionEvents?.signal.aborted) return
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
  if (config.rendererUrl) return // dev server: leave Vite's needs alone
  const voice = voiceConnectSource(config.voiceWsUrl)
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
    {
      host: config.sidecarHost,
      port: config.sidecarPort,
      repoRoot,
      stateDir: config.stateDir,
      command,
      args,
    },
    (status, detail) => console.log(`[aico] sidecar ${status}${detail ? `: ${detail}` : ''}`),
  )
  // Fire-and-forget: widgets render against tmux without the sidecar, so don't
  // gate the UI on it; the health result is logged via onStatus.
  sidecar.start().catch((err) => console.warn('[aico] sidecar start failed:', err))
}

lifecycle.onQuit(() => {
  link.stop()
  // A secondary instance (single-instance lock denied) quits before the app is
  // ready, where globalShortcut would throw; it never registered any anyway.
  if (app.isReady()) globalShortcut.unregisterAll()
  selectionEvents?.abort()
  sidecar?.stop()
  if (gazeTimer) clearTimeout(gazeTimer)
  layout.stop({ removeFile: lifecycle.runtimeOwner })
})
lifecycle.setActivationHandler(windows.activate)

const startup = app.whenReady().then(async () => {
  if (!lifecycle.runtimeOwner) return // no runtime initialization
  const { migrated } = initViews(config.dbPath)
  if (migrated) console.log(`[aico] copied ${migrated} window views from the pre-Tether catalog`)
  installContentSecurityPolicy()
  startSidecar()

  // No application menu — the Lantern chrome owns window controls, and the
  // default Edit menu's paste role mangled bracketed paste (handled in renderer).
  Menu.setApplicationMenu(null)

  terminal.registerIpc(ipcMain)

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
  chrome.registerIpc(ipcMain)

  sessions.registerIpc(ipcMain)
  ipcMain.on('selection:grab', () => void selectionGrab())
  // Desktop grab fired from a menu click (window pick / region drag). Args are the
  // aico-grab.sh flags chosen by the renderer; validated to a small allowlist.
  ipcMain.on('grab:run', (_event, args: string[]) => {
    const allowed = new Set(['-p', '-t', '-r'])
    if (Array.isArray(args) && args.every((a) => allowed.has(a))) runDesktopGrab(args)
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

  chrome.createTray({
    onSelect: windows.focusOrReopen,
    onDiscard: (id) => void sessions.confirmTrayDiscard(id),
    onNewWidget: windows.openNew,
    onRefreshSessions: () => {
      projects.invalidate()
      link.requestRefresh()
      void link.refreshTools().catch(() => {})
    },
    onHubView: windows.showAll,
  })
  scheduleGaze()
  layout.scheduleWrite()
  layout.enableTiling()
  // Returning to any Aico window refreshes the native tray catalog as well.
  // Linux does not provide a reliable async hook before its cached tray menu opens.
  app.on('browser-window-focus', chrome.syncTray)
  app.on('activate', chrome.syncTray)

  // System-wide indicate hotkey (X11). Logs whether the grab actually took, so
  // a silent Wayland no-op is visible in the launcher log.
  const hotkeyOk = globalShortcut.register(config.selectionHotkey, () => void selectionGrab())
  console.log(
    `[aico] selection hotkey ${config.selectionHotkey}: ${
      hotkeyOk ? 'registered' : 'unavailable (Wayland? bind a GNOME shortcut to the grab path)'
    }`,
  )

  // Push-to-talk hotkey (X11). Same Wayland caveat as the selection hotkey.
  ipcMain.handle('voice:ws-url', () => config.voiceWsUrl)
  // getUserMedia is denied by default. Bind the grant to a currently catalogued
  // Aico widget's main renderer document and to audio-only requests; another
  // webContents, iframe, navigated document, or video request is rejected.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, cb, details) => {
    const win = BrowserWindow.fromWebContents(webContents)
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    cb(
      allowTrustedAudioMedia({
        permission,
        trustedRenderer: win !== null && registry.hasSession(win.id),
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
        trustedRenderer: win !== null && registry.hasSession(win.id),
        currentUrl: webContents?.getURL() ?? '',
        requestingUrl: details.requestingUrl ?? requestingOrigin,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType ? [details.mediaType] : undefined,
      })
    },
  )
  const voiceHotkeyOk = globalShortcut.register(config.voicePttHotkey, toggleVoice)
  console.log(
    `[aico] voice PTT hotkey ${config.voicePttHotkey}: ${
      voiceHotkeyOk ? 'registered' : 'unavailable (Wayland? bind a GNOME shortcut to toggle voice)'
    }`,
  )

  // Browser-driven sends (and any CLI POST to /selection/send) arrive here.
  subscribeSelectionEvents()

  link.connect(applyGuiCommand)
  chrome.syncTray()
  lifecycle.markReady()
})
startup.catch(lifecycle.failStartup)
