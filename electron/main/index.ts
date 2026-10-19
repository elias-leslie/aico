import { execFile } from 'node:child_process'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
import { version } from '../../package.json'
import { createAmbient } from './ambient'
import { createAttentionWiring } from './attention-wiring'
import { readConfig } from './config'
import { registerDesktopIpc } from './desktop-ipc'
import { createGuiChannel } from './gui-channel'
import { createHotkeys } from './hotkeys'
import { createLifecycle } from './lifecycle'
import { denyAllPermissions } from './permissions'
import { ownStartTime, removeOwnPidFile } from './process-identity'
import { ensurePersonalWorkspaceRoot, ProjectCatalog, personalWorkspaceRoot } from './project'
import { createSelectionBus } from './selection-bus'
import { createSelectionListener } from './selection-listener'
import { createSessionActions } from './session-actions'
import { createSessionCatalog, type SessionCatalog, sessionTitle } from './session-catalog'
import { createAgentShares } from './show'
import { createTerminal } from './terminal'
import { TetherPool } from './tether-client'
import { createTetherLink } from './tether-link'
import { ControlTerminal } from './tmux-control'
import { sandboxedTmux, tmuxClientPid } from './tmux-sandbox'
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
const tether = new TetherPool([...config.tetherSockets])
const catalog: SessionCatalog = createSessionCatalog()

// Which window shows which session, where windows go, and the windows
// themselves. The hooks run, in this order, what the other feature modules
// (terminal, window chrome, ambient, attention, selection) do when a window
// loads, focuses, blurs or goes away.
const registry = new WindowRegistry(BrowserWindow)
const layout = createWindowLayout({
  registry,
  screen,
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
  agentSocket: config.agentTetherSocket,
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
    firstList: () => windows.restoreOnLaunch(),
    titles: () => chrome.pushTitles(),
    tray: () => chrome.syncTray(),
    connected: () => terminal.resumeAwaiting(),
    shared: (data) => shares.notify(data),
  },
})

// ---------------------------------------------------------------------------
// Attention: flash a window and badge the tray when a session needs the owner
// (attention.ts); after 2 minutes unanswered, one Nightshift push to the phone.

const attention = createAttentionWiring({
  registry,
  catalog,
  tools: link.tools,
  setNeedsYou,
  execFile,
  nightshift: config.nightshift,
  atermUrl: config.atermUrl,
})

// The eyes and the titlebar arcade: cursor pump, gaze scenes, urgent looks.
const ambient = createAmbient({
  registry,
  screen,
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
  sandboxTmux: sandboxedTmux,
  tmuxClientPid,
  controlTerminal: (argv, env, size) => new ControlTerminal(argv, env, size),
  execFileAsync: promisify(execFile),
  ensurePersonalWorkspaceRoot,
  isQuitting: lifecycle.isQuitting,
  env: process.env,
})

// The selection bus: where selections go and how they arrive.
const selection = createSelectionBus({
  registry,
  catalog,
  listViews,
  tether,
  isReplacing: sessions.isReplacing,
  isQuitting: lifecycle.isQuitting,
})

const previews = new Set<BrowserWindow>()
const shares = createAgentShares({
  exchangeRoot: config.exchangeRoot,
  windowFor: (id) => (id ? registry.forSession(id) : undefined) ?? registry.sessionWindows()[0],
  sessionName: (id) => {
    const descriptor = id ? catalog.get(id) : undefined
    return descriptor ? sessionTitle(descriptor) : undefined
  },
  clipboard,
  shell,
  dialog,
  preview: async (path, title) => {
    const win = new BrowserWindow({
      width: 900,
      height: 680,
      title,
      backgroundColor: '#0b0d11',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        javascript: false,
      },
    })
    previews.add(win)
    win.on('closed', () => previews.delete(win))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    try {
      await win.loadFile(path)
    } catch (error) {
      win.destroy()
      throw error
    }
  },
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

// Global shortcuts.
const hotkeys = createHotkeys({ grab: selection.grab, config, globalShortcut, app })

lifecycle.onQuit(() => {
  link.stop()
  hotkeys.stop()
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

  // No application menu — the Lantern chrome owns window controls, and the
  // default Edit menu's paste role mangled bracketed paste (handled in renderer).
  Menu.setApplicationMenu(null)

  terminal.registerIpc(ipcMain)
  registerDesktopIpc(ipcMain, {
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
  selection.registerIpc(ipcMain)
  shares.registerIpc(ipcMain)
  hotkeys.registerIpc(ipcMain)

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
  ambient.start()
  layout.scheduleWrite()
  layout.enableTiling()
  // Returning to any Aico window refreshes the native tray catalog as well.
  // Linux does not provide a reliable async hook before its cached tray menu opens.
  app.on('browser-window-focus', chrome.syncTray)
  app.on('activate', chrome.syncTray)

  hotkeys.registerSelection()

  link.connect(applyGuiCommand)
  chrome.syncTray()
  lifecycle.markReady()
})
startup.catch(lifecycle.failStartup)
