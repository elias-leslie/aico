// Session windows: making, restoring, focusing and closing them, and
// remembering their place. What other features do when a window loads,
// focuses, blurs or goes away arrives as hooks, in the order the root fixes.

import { join } from 'node:path'
import type { BrowserWindow, Menu } from 'electron'
import type { SessionDescriptor } from 'tether/client'
import { INK } from '../shared/palette'
import { type Compositor, toDip } from './compositor'
import { PERSONAL_WORKSPACE_ID } from './project'
import type { Bounds, ViewRow } from './views'
import type { PendingCreate, WindowRegistry } from './window-registry'

/** A window's renderer is reloaded after it dies at most this often. */
export const RELOAD_INTERVAL_MS = 10_000

interface BrowserWindowCtor {
  new (options: Electron.BrowserWindowConstructorOptions): BrowserWindow
  fromId(id: number): BrowserWindow | null
  getAllWindows(): BrowserWindow[]
}

interface WindowHooks {
  /** The renderer finished loading (first load and every reload). */
  loaded(win: BrowserWindow): void
  /** Runs before the window is told it has focus. */
  focused(win: BrowserWindow, sessionId: string | undefined): void
  /** Runs after the window is told it lost focus. */
  blurred(win: BrowserWindow): void
  /** The window was shown, hidden, minimized or restored. */
  visibility(win: BrowserWindow): void
  /** The window is gone: detach its terminal first, then drop per-window state. */
  disposing(winId: number): void
  /** The set of open windows changed. */
  changed(): void
}

interface WindowsDeps {
  registry: Pick<
    WindowRegistry,
    'bindSession' | 'setPending' | 'clearPending' | 'sessionOf' | 'forSession' | 'forget'
  >
  layout: {
    /** Gets a new, not yet shown window onto its tile (`tile`), its remembered place or nowhere in particular. */
    present(win: BrowserWindow, o: { tile: boolean; saved: Bounds | null }): Promise<void>
    persist(win: BrowserWindow): void
    scheduleWrite(): void
    retileDisplay(monitorId: string): void
  }
  /** Where windows are and how to move them (compositor.ts). */
  compositor: Pick<
    Compositor,
    | 'attach'
    | 'detach'
    | 'onChange'
    | 'bounds'
    | 'isMinimized'
    | 'monitors'
    | 'monitorFor'
    | 'raise'
    | 'scale'
  >
  views: {
    ensureView(id: string, open?: boolean): ViewRow
    setOpen(id: string, open: boolean): void
    getView(id: string): ViewRow | undefined
    listViews(): ViewRow[]
  }
  /** Tether currently lists this session. */
  isLive(id: string): boolean
  upsert(descriptor: SessionDescriptor): void
  catalogList(): SessionDescriptor[]
  isQuitting(): boolean
  hooks: WindowHooks
  /** The dev server URL; unset loads the built renderer. */
  rendererUrl?: string
  BrowserWindow: BrowserWindowCtor
  Menu: Pick<typeof Menu, 'buildFromTemplate'>
}

export function createWindows(deps: WindowsDeps) {
  const { registry, layout, views, compositor, hooks } = deps
  const boundsTimers = new Map<number, NodeJS.Timeout>()

  function scheduleBoundsSave(win: BrowserWindow): void {
    const prev = boundsTimers.get(win.id)
    if (prev) clearTimeout(prev)
    boundsTimers.set(
      win.id,
      setTimeout(() => layout.persist(win), 400),
    )
  }

  // Restore a saved rect only if it still lands on a connected display, fitted inside
  // that display's work area (a rect saved under another scale or panel can be larger);
  // otherwise keep just the size and let the compositor place it (avoids off-screen windows).
  function savedPlace(b: Bounds | null): Bounds | null {
    if (!b) return null
    const area = compositor.monitors().find(({ workArea: w }) => {
      return (
        b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y
      )
    })?.workArea
    if (!area) return null
    const width = Math.min(b.width, area.width)
    const height = Math.min(b.height, area.height)
    return {
      x: Math.min(Math.max(b.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(b.y, area.y), area.y + area.height - height),
      width,
      height,
    }
  }

  // Window size for the constructor, in DIP: the saved size (logical px), else a default.
  function initialSize(b: Bounds | null): { width: number; height: number } {
    if (!b) return { width: 900, height: 560 }
    return {
      width: toDip(b.width, compositor.scale()),
      height: toDip(b.height, compositor.scale()),
    }
  }

  // Rect changes (a drag, a resize, Aico's own placement) save the place and
  // refresh layout.json; a minimize or restore also resyncs the eyes. Electron's
  // own move/resize/minimize events are not reliable on Wayland, so the
  // compositor reports them.
  compositor.onChange((change) => {
    if (change.kind === 'monitors' || change.kind === 'availability') {
      layout.scheduleWrite()
      return
    }
    const win = deps.BrowserWindow.fromId(change.winId)
    if (!win || win.isDestroyed()) return
    if (change.kind === 'rect') scheduleBoundsSave(win)
    else hooks.visibility(win)
    layout.scheduleWrite()
  })

  /** One frameless widget window, bound to a session now (`view`) or once
   * Tether creates it (`pending`). */
  function createWidgetWindow(
    view: ViewRow | null,
    pending: PendingCreate | null,
    restore = false,
    inactive = false,
  ): BrowserWindow {
    const row = { id: view?.id ?? 'new' }
    const saved = savedPlace(view?.bounds ?? null)
    const win = new deps.BrowserWindow({
      ...initialSize(saved ?? view?.bounds ?? null),
      // Shown once the compositor has the window's place (below), so it never
      // appears somewhere else first.
      show: false,
      minWidth: 360,
      minHeight: 240,
      // Keep the frameless Lantern chrome, but make the native surface opaque.
      // These windows are often nearly full-height on a scaled 4K display; a
      // transparent surface made Chromium alpha-composite every terminal repaint
      // across tens of millions of pixels even though only the 8px rim used alpha.
      frame: false,
      // No native drop shadow. On a fractionally scaled Wayland display the shadow's
      // insets get re-rounded on every focus change, so each window grew 1-3 px a
      // time (terminal and chat windows alike). Lantern draws its own rim.
      hasShadow: false,
      transparent: false,
      backgroundColor: INK,
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

    // The compositor tags the title so it can find this window, before first show.
    compositor.attach(win)

    // Opened after startup: tile in on the screen under the pointer.
    const tile = !(restore && view?.bounds)
    void layout
      .present(win, { tile, saved })
      .catch((error: unknown) => console.warn('[aico] window placement failed:', error))
      .finally(() => {
        if (win.isDestroyed()) return
        if (inactive) win.showInactive()
        else win.show()
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
      deps.Menu.buildFromTemplate(suggestions).popup({ window: win })
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
    // A renderer killed under memory pressure (or crashed) leaves a blank window
    // over a live session: reload it, at most once per RELOAD_INTERVAL_MS, so a
    // renderer that keeps dying cannot spin. The reloaded page reattaches its
    // terminal as on any load; the session itself was never touched.
    let lastReloadAt = Number.NEGATIVE_INFINITY
    let reloadTimer: NodeJS.Timeout | null = null
    const reloadRenderer = () => {
      reloadTimer = null
      if (win.isDestroyed() || deps.isQuitting()) return
      lastReloadAt = Date.now()
      win.reload()
    }
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(
        `[aico:renderer] widget=${row.id} process gone reason=${details.reason} ` +
          `exit_code=${details.exitCode}`,
      )
      if (details.reason === 'clean-exit' || reloadTimer || deps.isQuitting()) return
      const wait = lastReloadAt + RELOAD_INTERVAL_MS - Date.now()
      if (wait <= 0) reloadRenderer()
      else reloadTimer = setTimeout(reloadRenderer, wait)
    })

    const winId = win.id
    if (view) {
      registry.bindSession(winId, view.id)
      views.setOpen(view.id, true)
    } else if (pending) {
      registry.setPending(winId, pending)
    }

    win.webContents.on('did-finish-load', () => hooks.loaded(win))

    if (deps.rendererUrl) {
      win.loadURL(deps.rendererUrl)
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'))
    }

    // Renderer toggles the focused/unfocused chrome state off these. Focus also
    // records this widget as the selection-grab target ("last-focused widget")
    // and claims the shared tmux window size for this view (the root's hooks).
    win.on('focus', () => {
      hooks.focused(win, registry.sessionOf(win.id))
      win.webContents.send('win:focus', true)
    })
    win.on('blur', () => {
      win.webContents.send('win:focus', false)
      hooks.blurred(win)
    })

    for (const change of ['focus', 'blur', 'show', 'hide'] as const)
      win.on(change as 'show', layout.scheduleWrite)
    for (const change of ['show', 'hide'] as const)
      win.on(change as 'show', () => hooks.visibility(win))
    let closingBounds: Bounds | null = null
    win.on('close', () => {
      layout.persist(win) // final flush while bounds are still valid
      closingBounds =
        win.isVisible() && !compositor.isMinimized(win) ? compositor.bounds(win) : null
    })

    win.on('closed', () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = null
      const widgetId = registry.sessionOf(winId)
      // Detaches the terminal first; the session persists (close = keep, reopenable).
      hooks.disposing(winId)
      const timer = boundsTimers.get(winId)
      if (timer) {
        clearTimeout(timer)
        boundsTimers.delete(winId)
      }
      registry.forget(winId)
      compositor.detach(winId)
      // Neighbours grow into the space this window leaves (not on quit: the
      // whole arrangement is coming back next launch).
      const freedOn = closingBounds && compositor.monitorFor(closingBounds)
      if (!deps.isQuitting() && freedOn) layout.retileDisplay(freedOn.id)
      layout.scheduleWrite()
      // On quit, leave `open` as-is so live views restore next launch; on an
      // explicit close, mark it closed (it moves to the tray's reopen list).
      if (!deps.isQuitting() && widgetId && views.getView(widgetId)) views.setOpen(widgetId, false)
      hooks.changed()
    })

    hooks.changed()
    return win
  }

  /** `restore`: reopen at the remembered place instead of tiling in. */
  function openWidget(id: string, restore = false): void {
    createWidgetWindow(views.ensureView(id), null, restore)
  }

  // A new session is always an explicit (tool, workspace) pair. Its window opens
  // at once; Tether creates the session at that window's first grid size.
  function newWidget(
    tool: string,
    projectId: string,
    instructions?: PendingCreate['instructions'],
  ): void {
    createWidgetWindow(null, { tool, projectId, ...(instructions ? { instructions } : {}) })
  }

  function focusOrReopen(id: string): void {
    const win = registry.forSession(id)
    if (win) {
      void compositor.raise(win)
      return
    }
    openWidget(id)
  }

  /** A due check-in: reopen a closed window of a session this desktop has
   * shown, at its remembered place and without taking focus. An open window is
   * left as it is; a session never shown here gets no window. */
  function reopenIfViewed(id: string): 'open' | 'reopened' | 'no_view' {
    if (registry.forSession(id)) return 'open'
    const view = views.getView(id)
    if (!view) return 'no_view'
    createWidgetWindow(view, null, true, true)
    return 'reopened'
  }

  return {
    openNew: newWidget,
    focusOrReopen,
    reopenIfViewed,

    restoreOnLaunch: (): void => {
      const live = views.listViews().filter((view) => deps.isLive(view.id))
      const open = live.filter((view) => view.open)
      if (open.length) {
        // Restore runs after the first session list, by which time tiling is
        // live; each window still goes back to where it was.
        for (const view of open) if (!registry.forSession(view.id)) openWidget(view.id, true)
      } else if (live.length && deps.BrowserWindow.getAllWindows().length === 0) {
        openWidget(live[0].id) // nothing was open: bring back the oldest view
      }
    },

    showAll: (): void => {
      for (const win of deps.BrowserWindow.getAllWindows()) win.show()
    },

    /** A desktop activation (launcher click, second instance). */
    activate: (): void => {
      const windows = deps.BrowserWindow.getAllWindows()
      if (windows.length > 0) {
        for (const win of windows) win.show()
        void compositor.raise(windows[0])
        return
      }
      const oldest = views.listViews().find((view) => deps.isLive(view.id)) ?? deps.catalogList()[0]
      if (oldest) focusOrReopen(oldest.id)
      else newWidget('shell', PERSONAL_WORKSPACE_ID)
    },

    /** Tether created the session this window was opened for. */
    bind: (win: BrowserWindow, descriptor: SessionDescriptor): void => {
      deps.upsert(descriptor)
      registry.bindSession(win.id, descriptor.id)
      registry.clearPending(win.id)
      views.ensureView(descriptor.id, true)
      views.setOpen(descriptor.id, true)
      layout.persist(win)
    },

    /** The session is absent from a complete list: close its window, keep its place. */
    destroyFor: (id: string): void => {
      registry.forSession(id)?.destroy()
    },

    /** The session ended: close its window and let neighbours grow into the space. */
    closeEnded: (id: string): void => {
      // destroy() skips the 'close' event, so take the space it leaves here and
      // let neighbours grow into it once the window is gone.
      const win = registry.forSession(id)
      const freed = win?.isVisible() && !compositor.isMinimized(win) ? compositor.bounds(win) : null
      const freedOn = freed && compositor.monitorFor(freed)
      if (win) compositor.detach(win.id)
      win?.destroy()
      if (freedOn && !deps.isQuitting()) setImmediate(() => layout.retileDisplay(freedOn.id))
    },
  }
}
