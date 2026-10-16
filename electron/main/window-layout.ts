// The window picture, in and out. Out: the picture main has of every Aico
// window is written to $XDG_RUNTIME_DIR/aico/layout.json so agents can see how
// the windows are arranged before moving them with `st aico widget position`.
// In: windows opened or closed after startup re-tile their screen (tiling.ts).

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, Screen } from 'electron'
import { arrange, type Rect } from './tiling'
import type { Bounds } from './views'
import type { WindowRegistry } from './window-registry'

export interface LayoutWindow {
  /** Tether session id; what `st aico widget position --widget-id` takes. */
  id: string
  name: string
  bounds: Rect
  displayId: string
  focused: boolean
  visible: boolean
  minimized: boolean
  maximized: boolean
  /** Marked as a coordinator: tiles in the centre column. */
  coordinator: boolean
}

export interface LayoutDisplay {
  id: string
  primary: boolean
  bounds: Rect
  /** Usable area (panels excluded); arrange windows inside this. */
  workArea: Rect
  scaleFactor: number
}

/** The Aico process that wrote the layout. */
export interface LayoutOwner {
  pid: number
  /** `/proc/<pid>/stat` field 22 as printed (see process-identity.ts); null
   * if procfs couldn't be read. A file whose pid is gone, or whose pid now
   * has another start time, was left by a crash: no Aico is running. */
  startTime: string | null
}

export interface Layout extends LayoutOwner {
  v: 1
  updatedAt: string
  displays: LayoutDisplay[]
  windows: LayoutWindow[]
}

export function layoutSnapshot(
  displays: LayoutDisplay[],
  windows: LayoutWindow[],
  owner: LayoutOwner,
  now = new Date(),
): Layout {
  const order = (w: LayoutWindow): [number, number] => [w.bounds.y, w.bounds.x]
  const sorted = [...windows].sort((p, q) => {
    const [py, px] = order(p)
    const [qy, qx] = order(q)
    return px - qx || py - qy
  })
  return {
    v: 1,
    pid: owner.pid,
    startTime: owner.startTime,
    updatedAt: now.toISOString(),
    displays,
    windows: sorted,
  }
}

interface LayoutFileDeps {
  path: string
  owner: LayoutOwner
  collect(): { displays: LayoutDisplay[]; windows: LayoutWindow[] }
  isReady(): boolean
  isQuitting(): boolean
}

/** layout.json itself: debounced writes, and removal at quit by the runtime that wrote it. */
export function createLayoutFile(deps: LayoutFileDeps) {
  let layoutTimer: ReturnType<typeof setTimeout> | undefined
  // A burst of changes (a drag, several sessions updating at once) writes once,
  // 300 ms after it settles, but never later than 1 s after the first change.
  let layoutDeadline = 0

  function writeNow(): void {
    const { displays, windows } = deps.collect()
    try {
      mkdirSync(join(deps.path, '..'), { recursive: true, mode: 0o700 })
      const tmp = `${deps.path}.${process.pid}.tmp`
      writeFileSync(
        tmp,
        `${JSON.stringify(layoutSnapshot(displays, windows, deps.owner), null, 2)}\n`,
        {
          mode: 0o600,
        },
      )
      renameSync(tmp, deps.path)
    } catch (error) {
      console.warn('[aico:layout] write failed:', error instanceof Error ? error.message : error)
    }
  }

  function scheduleWrite(): void {
    // Before ready there is no screen to read (startup writes once when ready);
    // after quit starts, a late write would undo the unlink at quit.
    if (deps.isQuitting() || !deps.isReady()) return
    const now = Date.now()
    if (layoutTimer) clearTimeout(layoutTimer)
    else layoutDeadline = now + 1000
    layoutTimer = setTimeout(
      () => {
        layoutTimer = undefined
        writeNow()
      },
      Math.max(0, Math.min(300, layoutDeadline - now)),
    )
  }

  function stop({ removeFile }: { removeFile: boolean }): void {
    if (layoutTimer) clearTimeout(layoutTimer)
    // Only the runtime that wrote layout.json removes it. A launcher click
    // (`--aico-activate`) quits through here too while the runtime keeps going.
    if (!removeFile) return
    try {
      const written = JSON.parse(readFileSync(deps.path, 'utf8')) as { pid?: unknown }
      if (written.pid === deps.owner.pid) unlinkSync(deps.path) // no Aico running: no layout
    } catch {
      // Never written, or already gone.
    }
  }

  return { scheduleWrite, writeNow, stop }
}

type ScreenLike = Pick<
  Screen,
  | 'getAllDisplays'
  | 'getCursorScreenPoint'
  | 'getDisplayMatching'
  | 'getDisplayNearestPoint'
  | 'getPrimaryDisplay'
>

interface WindowLayoutDeps {
  registry: Pick<WindowRegistry, 'sessionWindows' | 'sessionOf' | 'forSession' | 'focused'>
  /** Read only after the app is ready. */
  screen: ScreenLike
  isCoordinator(id: string): boolean
  /** The title layout.json shows for a session. */
  sessionName(id: string): string
  saveBounds(id: string, bounds: Bounds, displayId: string): void
  isReady(): boolean
  isQuitting(): boolean
  path: string
  owner: LayoutOwner
}

export function createWindowLayout(deps: WindowLayoutDeps) {
  const { registry, screen } = deps

  const file = createLayoutFile({
    path: deps.path,
    owner: deps.owner,
    isReady: deps.isReady,
    isQuitting: deps.isQuitting,
    collect: () => {
      const focused = registry.focused()
      const windows: LayoutWindow[] = []
      for (const w of registry.sessionWindows()) {
        const id = registry.sessionOf(w.id)
        if (!id) continue
        const bounds = w.getBounds()
        windows.push({
          id,
          name: deps.sessionName(id),
          bounds,
          displayId: String(screen.getDisplayMatching(bounds).id),
          focused: w === focused,
          visible: w.isVisible(),
          minimized: w.isMinimized(),
          maximized: w.isMaximized(),
          coordinator: deps.isCoordinator(id),
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
      return { displays, windows }
    },
  })

  // Windows Aico itself just resized (tiling, re-tiling, an agent's position):
  // their next terminal resize claims the tmux size even while unfocused, or the
  // grown window would show the old grid in a sea of dots until clicked.
  const arrangedUntil = new Map<number, number>()
  function setArrangedBounds(win: BrowserWindow, bounds: Bounds): void {
    arrangedUntil.set(win.id, Date.now() + 3000)
    win.setBounds(bounds)
  }

  // Persist a window's bounds (and which monitor it's on) so it restores in place.
  function persistBounds(win: BrowserWindow): void {
    const widgetId = registry.sessionOf(win.id)
    if (!widgetId || win.isDestroyed()) return
    const bounds = win.getBounds()
    deps.saveBounds(widgetId, bounds, String(screen.getDisplayMatching(bounds).id))
  }

  // Windows opened or closed after startup re-tile their screen to the layout
  // for the new count (see tiling.ts tileGroups and arrange). Restoring at launch keeps each
  // window's remembered place.
  let tilingLive = false
  const NEW_WINDOW = '(new)'

  function tileable(displayId: number): { id: string; bounds: Bounds }[] {
    return registry
      .sessionWindows()
      .filter((w) => w.isVisible() && !w.isMinimized() && !w.isMaximized())
      .filter((w) => screen.getDisplayMatching(w.getBounds()).id === displayId)
      .map((w) => {
        const id = registry.sessionOf(w.id) ?? ''
        return { id, bounds: w.getBounds(), coordinator: Boolean(id && deps.isCoordinator(id)) }
      })
      .filter((w) => w.id)
  }

  function applyMoves(moves: { id: string; bounds: Bounds }[]): void {
    for (const move of moves) {
      const win = registry.forSession(move.id)
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
    if (before === undefined || before === coordinator || deps.isQuitting()) return
    retileDisplay(screen.getDisplayMatching(win.getBounds()).id)
    file.scheduleWrite()
  }

  return {
    /** No-op before ready or while quitting; 300 ms settle, 1 s cap. */
    scheduleWrite: file.scheduleWrite,
    /** Clears a pending write; removes layout.json only if asked and this process wrote it. */
    stop: file.stop,
    enableTiling: (): void => {
      tilingLive = true
    },
    /** Where a window opening now goes (moving the others), or null before tiling is live. */
    placeNew: (): Bounds | null => (tilingLive ? tileNewWindow() : null),
    retileDisplay,
    noteCoordinator: retileOnCoordinatorChange,
    /** An agent's position command: set the bounds and remember them. */
    arrange: (win: BrowserWindow, bounds: Bounds): void => {
      setArrangedBounds(win, bounds)
      persistBounds(win)
    },
    persist: persistBounds,
    /** Aico resized this window in the last 3 s: its next terminal resize claims the tmux size. */
    recentlyArranged: (winId: number): boolean => (arrangedUntil.get(winId) ?? 0) > Date.now(),
    /** Drops the arranged mark only; the last seen coordinator mark is kept, as before. */
    forget: (winId: number): void => {
      arrangedUntil.delete(winId)
    },
  }
}

export type WindowLayout = ReturnType<typeof createWindowLayout>
