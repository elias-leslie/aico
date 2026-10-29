import { execFile } from 'node:child_process'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
} from 'electron'
import {
  createSessionCatalog,
  createTetherLink,
  type SessionCatalog,
  TetherPool,
} from 'tether/client'
import { ControlTerminal } from 'tether/term'
import { version } from '../../package.json'
import { TERMINAL_HISTORY_LINES } from '../shared/terminal-history'
import { createAmbient } from './ambient'
import { createAttentionWiring } from './attention-wiring'
import { createBridgeTransport } from './bridge-transport'
import { createChatBridge } from './chat-bridge'
import { CHAT_TOOL, createChatLauncher } from './chat-launch'
import { createBridgeCompositor, createNativeCompositor, whenReady } from './compositor'
import { readConfig } from './config'
import { registerDesktopIpc } from './desktop-ipc'
import { createGuiChannel } from './gui-channel'
import { createInstructions } from './instructions'
import { createLifecycle } from './lifecycle'
import { createOwnerSurface } from './owner-surface'
import { denyAllPermissions } from './permissions'
import { ownStartTime, removeOwnPidFile } from './process-identity'
import { ensurePersonalWorkspaceRoot, ProjectCatalog, personalWorkspaceRoot } from './project'
import { createRuns } from './runs'
import { createSelectionBus } from './selection-bus'
import { createSelectionListener } from './selection-listener'
import { createSessionActions } from './session-actions'
import { sessionTitle } from './session-catalog'
import { createAgentShares } from './show'
import { createTerminal } from './terminal'
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

// The composition root: it builds every feature module, hands each the others
// it needs as closures, and runs startup and quit in order. No feature module
// imports another, not even for a type (each declares what it needs of the
// others structurally); this file is the only place they meet.

const config = readConfig(process.env, homedir(), process.getuid?.(), process.argv)
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
// geometry and its settings. A window's terminal is a tmux control-mode client on
// the socket and target Tether hands out; killing it only detaches, so the
// session survives close, reload and Aico restarts.
const tether = new TetherPool([...config.tetherSockets])
const catalog: SessionCatalog = createSessionCatalog()

// Which window shows which session, where windows go, and the windows
// themselves. The hooks run, in this order, what the other feature modules
// (terminal, window chrome, ambient, attention, selection) do when a window
// loads, focuses, blurs or goes away.
const registry = new WindowRegistry(BrowserWindow)
// Where windows are and how they are moved: the desktop bridge on Wayland, where
// Electron cannot say or move them; Electron's own calls on X11. Nothing else
// knows which (compositor.ts). `scale` is logical px per DIP: Chromium's forced
// device scale factor, which the launcher sets from GNOME's text scaling.
const compositor =
  config.displayBackend === 'wayland'
    ? createBridgeCompositor({
        transport: createBridgeTransport(),
        pid: process.pid,
        scale: () => screen.getPrimaryDisplay().scaleFactor,
      })
    : createNativeCompositor({ screen })
// Launch restore waits this long for the bridge's first sync (normally well under it).
const RESTORE_WAIT_MS = 2000
const layout = createWindowLayout({
  registry,
  compositor,
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
// Whether the owner works on this desktop or in the web app: Tether's own
// shows open windows here only in the first case (owner-surface.ts).
const ownerSurface = createOwnerSurface({ getSetting, setSetting })
const windows = createWindows({
  registry,
  layout,
  views: { ensureView, setOpen, getView, listViews },
  compositor,
  isLive: (id) => Boolean(catalog.get(id)),
  ownerOnDesktop: ownerSurface.onDesktop,
  upsert: (descriptor) => catalog.upsert(descriptor),
  catalogList: () => catalog.list(),
  isQuitting: lifecycle.isQuitting,
  rendererUrl: config.rendererUrl,
  BrowserWindow,
  Menu,
  hooks: {
    loaded: (win) => {
      chrome.refreshContextBadge(win)
      attention.sendTo(win)
    },
    focused: (win, widgetId) => {
      selection.noteFocus(widgetId)
      if (widgetId) {
        attention.focused(widgetId)
        chrome.syncTray()
      }
      terminal.claimSize(win.id)
      ambient.focused(win.id)
    },
    blurred: (win) => ambient.blurred(win.id),
    input: () => ownerSurface.used(),
    visibility: () => ambient.visibilityChanged(),
    disposing: (winId) => {
      // Terminal: detach first; the session persists (close = keep, reopenable).
      terminal.forget(winId)
      // Titlebar and tray.
      chrome.forget(winId)
      // Eyes and arcade.
      ambient.forget(winId)
      layout.forget(winId)
    },
    changed: () => chrome.syncTray(),
  },
})

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
  shareSocket: config.shareTetherSocket,
  catalog,
  projects,
  dialog,
  hooks: {
    agentState: (descriptor) => {
      attention.update(descriptor)
      // A window that lost its terminal reattaches once its session runs again.
      terminal.sessionSeen(descriptor)
    },
    removed: (id) => attention.removed(id),
    destroyWindow: (id) => windows.destroyFor(id),
    closeEnded: (id) => windows.closeEnded(id),
    retired: (id) => removeView(id),
    firstList: () =>
      void Promise.all([
        whenReady(compositor, RESTORE_WAIT_MS),
        ownerSurface.seed(() =>
          Promise.all(
            catalog.list().map((descriptor) =>
              tether.resizeHolder(descriptor.id).then(
                (answer) => answer.holder,
                () => null,
              ),
            ),
          ),
        ),
      ]).then(() => windows.restoreOnLaunch()),
    titles: () => chrome.pushTitles(),
    tray: () => chrome.syncTray(),
    runs: (answer) => runs.apply(answer),
    connected: () => terminal.resumeAwaiting(),
    shared: (data) => shares.notify(data),
    sizeHeld: (id, clientPid, viewer) => {
      ownerSurface.sizeHeld(viewer)
      terminal.sizeHeldBy(id, clientPid)
    },
  },
})

// ---------------------------------------------------------------------------
// Attention: flash a window and badge the tray when a session needs the owner
// (attention.ts); after 2 minutes unanswered, one Nightshift push to the phone.

const attention = createAttentionWiring({
  registry,
  compositor,
  catalog,
  tools: link.tools,
  setNeedsYou,
  execFile,
  nightshift: config.nightshift,
  webUrl: config.webUrl,
  run: (id) => runs.member(id),
})

// Workflow runs of the sessions (Tether lists them): running steps as tray rows,
// and the same needs-you signal sessions raise.
const runs = createRuns({
  attention,
  tray: () => chrome.syncTray(),
  tools: link.tools,
  openStep: (viewer) => windows.openStepViewer(viewer),
})

// The eyes and the titlebar arcade: cursor pump, gaze scenes, urgent looks.
const ambient = createAmbient({
  registry,
  compositor,
  getSetting,
  setSetting,
  urgent: attention.urgent,
  isQuitting: lifecycle.isQuitting,
})
ambient.startUrgentLooks()

// ---------------------------------------------------------------------------
// Tray and titlebars.

const chrome = createWindowChrome({
  registry,
  catalog,
  tools: link.tools,
  notice: link.notice,
  projects,
  attention,
  runs,
  layout,
  contextCheck: (id) => tether.contextCheck(id),
  isQuitting: lifecycle.isQuitting,
  tray: { createTray, refreshTray, setWidgetActivity },
})

const applyGuiCommand = createGuiChannel({
  layout: layout.snapshot,
  isQuitting: lifecycle.isQuitting,
  catalog,
  refresh: link.refresh,
  ownerOnDesktop: ownerSurface.onDesktop,
  focusOrReopen: windows.focusOrReopen,
  reopenIfViewed: windows.reopenIfViewed,
  forSession: registry.forSession,
  arrange: layout.arrange,
  canPlace: () => compositor.ready(),
  saveBounds,
  displayIdFor: (bounds) => compositor.monitorFor(bounds)?.id ?? '',
  titles: () => chrome.pushTitles(),
  tray: () => chrome.syncTray(),
})

// A new Agent Hub chat is created first and its window opens on it; every other
// tool opens its window first and Tether creates the session at its grid size.
const launchChat = createChatLauncher({
  tether,
  catalog,
  show: windows.focusOrReopen,
  fail: (message) => void dialog.showMessageBox({ type: 'error', message, buttons: ['OK'] }),
})
const newSession: typeof windows.openNew = (tool, projectId, instructions) => {
  if (tool === CHAT_TOOL) void launchChat(projectId)
  else windows.openNew(tool, projectId, instructions)
}

// What the owner can do to a session, all through Tether.
const sessions = createSessionActions({
  tether,
  catalog,
  link,
  registry,
  windows: { ...windows, openNew: newSession },
  projects,
  titles: () => chrome.pushTitles(),
  tray: () => chrome.syncTray(),
  dialog,
  personalWorkspace: { ensureRoot: ensurePersonalWorkspaceRoot, root: personalWorkspaceRoot },
})

// The Agent Hub prompt revisions a new session can take as instructions.
const instructions = createInstructions({ st: config.st, execFile })

// The native chat of an Agent Hub session window: every call goes to Tether,
// which holds the Agent Hub credentials (chat-bridge.ts).
const chatBridge = createChatBridge({ tether, catalog, registry })

// Terminal byte path: one control-mode terminal link per window.
const terminal = createTerminal({
  tether,
  catalog,
  registry,
  bind: windows.bind,
  ensureView,
  refresh: link.refresh,
  requestRefresh: link.requestRefresh,
  isReplacing: sessions.isReplacing,
  recentlyArranged: layout.recentlyArranged,
  titles: () => chrome.pushTitles(),
  tray: () => chrome.syncTray(),
  controlTerminal: (argv, env, size) =>
    new ControlTerminal(argv, env, size, {
      historyLines: TERMINAL_HISTORY_LINES,
      onReseed: (r) =>
        console.log(
          `[aico:event] terminal_reseed reason=${r.reason} target=${r.target} ` +
            `read_ms=${r.readMs} seed_bytes=${r.seedBytes} since_input_ms=${r.sinceInputMs}`,
        ),
    }),
  ensurePersonalWorkspaceRoot,
  instructionsSnapshot: instructions.snapshot,
  isQuitting: lifecycle.isQuitting,
  viewer: { app: 'desktop', device: hostname() },
})

// The selection bus: where selections go and how they arrive.
const selection = createSelectionBus({
  registry,
  catalog,
  listViews,
  tether,
  isReplacing: sessions.isReplacing,
  isQuitting: lifecycle.isQuitting,
  raise: (win) => void compositor.raise(win),
})

const shares = createAgentShares({
  webUrl: config.webUrl,
  windowFor: (id) => (id ? registry.forSession(id) : undefined) ?? registry.sessionWindows()[0],
  sessionName: (id) => {
    const descriptor = id ? catalog.get(id) : undefined
    return descriptor ? sessionTitle(descriptor) : undefined
  },
  clipboard,
  shell,
  dialog,
})

// The loopback listener: /health, and sends from the browser extension and
// `st selection send`, delivered through the selection bus.
const listener = createSelectionListener({
  host: config.listenerHost,
  port: config.listenerPort,
  extensionIds: config.extensionIds,
  // package.json's, whichever way Electron was launched (app.getVersion() is
  // Electron's own when started on the bundle path).
  version,
  deliver: selection.deliver,
})

lifecycle.onQuit(() => {
  link.stop()
  compositor.stop()
  listener.stop()
  ambient.stop()
  layout.stop({ removeFile: lifecycle.runtimeOwner })
})
lifecycle.setActivationHandler(windows.activate)

const startup = app.whenReady().then(async () => {
  if (!lifecycle.runtimeOwner) return // no runtime initialization
  initViews(config.dbPath)
  // Before any window exists: Electron would otherwise grant every request.
  denyAllPermissions(session.defaultSession)
  // Fire-and-forget: windows work without capture; the result is logged.
  void listener.start()
  // The bridge may appear later (the extension loads after us): the compositor
  // watches the bus name and fills its cache whenever it does.
  compositor.start()

  // No application menu — the Lantern chrome owns window controls, and the
  // default Edit menu's paste role mangled bracketed paste (handled in renderer).
  Menu.setApplicationMenu(null)

  terminal.registerIpc(ipcMain)
  chatBridge.registerIpc(ipcMain)
  registerDesktopIpc(ipcMain, {
    compositor,
    clipboard,
    pastedImages: config.pastedImages,
    shell,
    registry,
    getSetting,
    setSetting,
  })
  ambient.registerIpc(ipcMain)
  chrome.registerIpc(ipcMain)
  sessions.registerIpc(ipcMain)
  instructions.registerIpc(ipcMain)
  selection.registerIpc(ipcMain)
  shares.registerIpc(ipcMain)

  chrome.createTray({
    onSelect: windows.focusOrReopen,
    onDiscard: (id) => void sessions.confirmTrayDiscard(id),
    onCancelCheckIn: sessions.cancelCheckIn,
    onNewWidget: newSession,
    onRefreshSessions: () => {
      projects.invalidate()
      link.requestRefresh()
      void link.refreshTools().catch(() => {})
    },
    onHubView: windows.showAll,
    onOpenStep: (runId, stepKey) => runs.openStep(runId, stepKey),
  })
  ambient.start()
  layout.scheduleWrite()
  layout.enableTiling()
  // Returning to any Aico window refreshes the native tray catalog as well.
  // Linux does not provide a reliable async hook before its cached tray menu opens.
  app.on('browser-window-focus', chrome.syncTray)
  app.on('activate', chrome.syncTray)

  link.connect(applyGuiCommand)
  chrome.syncTray()
  lifecycle.markReady()
})
startup.catch(lifecycle.failStartup)
