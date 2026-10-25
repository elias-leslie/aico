// The window picture, in and out. Out: the picture main has of every Aico
// window is available live over Tether's GUI channel and written privately to
// $XDG_RUNTIME_DIR/aico/layout.json. `st aico layout` reads the live snapshot.
// In: windows opened or closed after startup re-tile their screen (tiling.ts).
// Every rect is global logical pixels as the compositor reports them (compositor.ts).

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { COMPOSITOR_UNAVAILABLE, type Compositor, type PlaceResult, sameRect } from './compositor'
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

/** What the layout's geometry rests on. */
interface LayoutCollected {
  displays: LayoutDisplay[]
  windows: LayoutWindow[]
  /** False while the compositor cannot say where windows are (the bridge is absent). */
  boundsReliable: boolean
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
  /** False: window positions and displays below are not real (compositor unavailable); do not plan moves from them. */
  boundsReliable: boolean
  displays: LayoutDisplay[]
  windows: LayoutWindow[]
}

export function layoutSnapshot(
  displays: LayoutDisplay[],
  windows: LayoutWindow[],
  owner: LayoutOwner,
  now = new Date(),
  boundsReliable = true,
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
    boundsReliable,
    displays,
    windows: sorted,
  }
}

interface LayoutFileDeps {
  path: string
  owner: LayoutOwner
  collect(): LayoutCollected
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
    const { displays, windows, boundsReliable } = deps.collect()
    try {
      mkdirSync(join(deps.path, '..'), { recursive: true, mode: 0o700 })
      const tmp = `${deps.path}.${process.pid}.tmp`
      writeFileSync(
        tmp,
        `${JSON.stringify(layoutSnapshot(displays, windows, deps.owner, new Date(), boundsReliable), null, 2)}\n`,
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

interface WindowLayoutDeps {
  registry: Pick<WindowRegistry, 'sessionWindows' | 'sessionOf' | 'forSession' | 'focused'>
  compositor: Compositor
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
  const { registry, compositor } = deps

  function collect(): LayoutCollected {
    const focused = registry.focused()
    const windows: LayoutWindow[] = []
    for (const w of registry.sessionWindows()) {
      const id = registry.sessionOf(w.id)
      if (!id) continue
      const bounds = compositor.bounds(w)
      windows.push({
        id,
        name: deps.sessionName(id),
        bounds,
        displayId: compositor.monitorFor(bounds)?.id ?? '',
        focused: w === focused,
        visible: w.isVisible(),
        minimized: compositor.isMinimized(w),
        maximized: compositor.isMaximized(w),
        coordinator: deps.isCoordinator(id),
      })
    }
    const displays = compositor.monitors().map((m) => ({
      id: m.id,
      primary: m.primary,
      bounds: m.bounds,
      workArea: m.workArea,
      scaleFactor: m.scale,
    }))
    return { displays, windows, boundsReliable: compositor.ready() }
  }

  const file = createLayoutFile({
    path: deps.path,
    owner: deps.owner,
    isReady: deps.isReady,
    isQuitting: deps.isQuitting,
    collect,
  })

  // Windows Aico itself just resized (tiling, re-tiling, an agent's position):
  // their next terminal resize claims the tmux size even while unfocused, or the
  // grown window would show the old grid in a sea of dots until clicked.
  const arrangedUntil = new Map<number, number>()
  async function setArrangedBounds(win: BrowserWindow, bounds: Bounds): Promise<PlaceResult> {
    arrangedUntil.set(win.id, Date.now() + 3000)
    const result = await compositor.place(win, bounds)
    if (!result.ok) console.warn(`[aico:layout] window ${win.id} not placed: ${result.error}`)
    return result
  }

  // Persist a window's bounds (and which monitor it's on) so it restores in place.
  // While the compositor cannot say where windows are, the remembered place stays.
  function persistBounds(win: BrowserWindow): void {
    const widgetId = registry.sessionOf(win.id)
    if (!widgetId || win.isDestroyed() || !compositor.ready()) return
    const bounds = compositor.bounds(win)
    deps.saveBounds(widgetId, bounds, compositor.monitorFor(bounds)?.id ?? '')
  }

  // Windows opened or closed after startup re-tile their screen to the layout
  // for the new count (see tiling.ts tileGroups and arrange). Restoring at launch keeps each
  // window's remembered place.
  let tilingLive = false
  const NEW_WINDOW = '(new)'

  function tileable(monitorId: string): { id: string; bounds: Bounds; coordinator: boolean }[] {
    return registry
      .sessionWindows()
      .filter((w) => w.isVisible() || compositor.isPlacing(w))
      .filter((w) => !compositor.isMinimized(w) && !compositor.isMaximized(w))
      .filter((w) => compositor.monitorFor(compositor.bounds(w))?.id === monitorId)
      .map((w) => {
        const id = registry.sessionOf(w.id) ?? ''
        return {
          id,
          bounds: compositor.bounds(w),
          coordinator: Boolean(id && deps.isCoordinator(id)),
        }
      })
      .filter((w) => w.id)
  }

  function applyMoves(moves: { id: string; bounds: Bounds }[]): void {
    for (const move of moves) {
      const win = registry.forSession(move.id)
      // Same place within the compositor's tolerance: leave it, or DIP rounding would re-tile forever.
      if (!win || sameRect(compositor.bounds(win), move.bounds, compositor.tolerance())) continue
      void setArrangedBounds(win, move.bounds)
      persistBounds(win) // the target, until the compositor confirms
    }
  }

  /** Where a window opening now goes; moves the others to make room. */
  async function tileNewWindow(): Promise<Bounds | null> {
    const cursor = await compositor.cursor()
    const monitors = compositor.monitors()
    const monitor =
      (cursor ? compositor.monitorNear(cursor) : undefined) ??
      monitors.find((m) => m.primary) ??
      monitors[0]
    if (!monitor) return null
    const moves = arrange(monitor.workArea, tileable(monitor.id), NEW_WINDOW)
    applyMoves(moves.filter((m) => m.id !== NEW_WINDOW))
    return moves.find((m) => m.id === NEW_WINDOW)?.bounds ?? monitor.workArea
  }

  function retileDisplay(monitorId: string): void {
    if (!compositor.ready()) return
    const monitor = compositor.monitors().find((m) => m.id === monitorId)
    if (monitor) applyMoves(arrange(monitor.workArea, tileable(monitor.id)))
  }

  // Two windows opening together must not take the same slot: each one's slot
  // is chosen, and its placement requested (so the next one sees it), in turn.
  let opening: Promise<unknown> = Promise.resolve()

  /**
   * Gets a new, not yet shown window onto its rect: a tile on the screen under
   * the pointer when `tile` and tiling is on, else `saved`, else wherever the
   * compositor puts it. Resolves when it is safe to show.
   */
  function present(win: BrowserWindow, o: { tile: boolean; saved: Bounds | null }): Promise<void> {
    const step = async (): Promise<void> => {
      const tiled = o.tile && tilingLive && compositor.ready() ? await tileNewWindow() : null
      const rect = tiled ?? o.saved
      if (rect) await compositor.prepare(win, rect)
    }
    const chained = opening.then(step, step)
    opening = chained.catch(() => {})
    return chained
  }

  // The coordinator mark lives on the Tether descriptor. Each window's last
  // seen mark, so a change (from any app or `st aico widget coordinator`)
  // re-tiles its screen; a window seen for the first time keeps its place.
  const shownCoordinator = new Map<number, boolean>()

  function retileOnCoordinatorChange(win: BrowserWindow, coordinator: boolean): void {
    const before = shownCoordinator.get(win.id)
    shownCoordinator.set(win.id, coordinator)
    if (before === undefined || before === coordinator || deps.isQuitting()) return
    const monitor = compositor.monitorFor(compositor.bounds(win))
    if (monitor) retileDisplay(monitor.id)
    file.scheduleWrite()
  }

  return {
    /** Current window picture, independent of the debounced private file. */
    snapshot: (): Layout | null => {
      if (!deps.isReady() || deps.isQuitting()) return null
      const { displays, windows, boundsReliable } = collect()
      return layoutSnapshot(displays, windows, deps.owner, new Date(), boundsReliable)
    },
    /** No-op before ready or while quitting; 300 ms settle, 1 s cap. */
    scheduleWrite: file.scheduleWrite,
    /** Clears a pending write; removes layout.json only if asked and this process wrote it. */
    stop: file.stop,
    enableTiling: (): void => {
      tilingLive = true
    },
    present,
    retileDisplay,
    noteCoordinator: retileOnCoordinatorChange,
    /** An agent's position command: place the window, remember the bounds once it is there. */
    arrange: async (win: BrowserWindow, bounds: Bounds): Promise<PlaceResult> => {
      if (!compositor.ready()) return { ok: false, error: COMPOSITOR_UNAVAILABLE }
      const result = await setArrangedBounds(win, bounds)
      if (result.ok) persistBounds(win)
      return result
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
