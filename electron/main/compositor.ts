// The compositor: where windows really are. Nothing else in Aico knows which
// compositor runs; it asks this module for geometry (synchronously, from a
// cache) and asks it to place, raise and watch windows.
//
// Two backends behind one interface:
//   bridge  Native Wayland. GNOME hides window positions from clients, and
//           Electron's own setPosition/getPosition/cursor point do nothing
//           there, so a GNOME Shell extension we own (the desktop bridge, in
//           the desktop-automation repo, docs/desktop-bridge.md) reports every
//           window's real frame rect and places windows on request.
//   native  X11 (AICO_OZONE_PLATFORM=x11): Electron's own calls work.
//
// Units. Rects here are global logical pixels, the compositor's own unit and
// the one layout.json, `st aico widget position` and saved bounds use. Electron
// sizes are DIP: under native Wayland with --force-device-scale-factor=S, a
// window of N DIP is N*S logical px (measured against the bridge: 800 DIP
// became 1251 px at S=1.5625). `toDip` and `fromDip` are the only conversion.
//
// Window identity. Every Aico window has the same pid, app id and title, so
// each gets a token, `[aico w<BrowserWindow id>]`, appended to its title
// before first show. The bridge matches windows by pid and "title contains
// token"; the brackets keep w1 from matching inside w12.

import type { BrowserWindow, Screen } from 'electron'
import type { Rect } from './tiling'

export type { Rect }

export interface Point {
  x: number
  y: number
}

export interface MonitorInfo {
  id: string
  primary: boolean
  bounds: Rect
  /** Usable area (panels excluded). */
  workArea: Rect
  scale: number
}

export type PlaceResult = { ok: true } | { ok: false; error: string }

/** Error codes of a refused or unconfirmed placement (also what `st aico widget position` reports). */
export const COMPOSITOR_UNAVAILABLE = 'compositor_unavailable'
export const PLACEMENT_UNCONFIRMED = 'placement_unconfirmed'
export const PLACEMENT_FAILED = 'placement_failed'

export type CompositorChange =
  | { kind: 'rect'; winId: number }
  | { kind: 'state'; winId: number }
  | { kind: 'monitors' }
  | { kind: 'availability' }

/** The BrowserWindow surface the compositor touches. */
export type CompositorWindow = Pick<
  BrowserWindow,
  | 'id'
  | 'isDestroyed'
  | 'isMinimized'
  | 'isMaximized'
  | 'isFocused'
  | 'getBounds'
  | 'getSize'
  | 'setBounds'
  | 'setSize'
  | 'setTitle'
  | 'getTitle'
  | 'show'
  | 'focus'
  | 'on'
>

export interface Compositor {
  /** Which backend this is. */
  readonly backend: 'bridge' | 'native'
  /** Geometry reads are real right now (always true natively; false while the bridge is absent). */
  ready(): boolean
  /** Connect and start watching. Call once the app is ready. */
  start(): void
  stop(): void
  /** Tags the window for the compositor (title token) and starts tracking it. Before first show. */
  attach(win: CompositorWindow): void
  detach(winId: number): void
  onChange(listener: (change: CompositorChange) => void): () => void

  // Reads: synchronous, from the cache.
  /** The window's frame rect; where it is going while a placement is in flight. */
  bounds(win: CompositorWindow): Rect
  isMinimized(win: CompositorWindow): boolean
  isMaximized(win: CompositorWindow): boolean
  isFocused(win: CompositorWindow): boolean
  /** A placement was requested and has not been confirmed or given up on. */
  isPlacing(win: CompositorWindow): boolean
  monitors(): MonitorInfo[]
  /** The monitor holding most of `rect`, else the nearest. */
  monitorFor(rect: Rect): MonitorInfo | undefined
  monitorNear(point: Point): MonitorInfo | undefined
  /** Logical px per DIP. */
  scale(): number
  /** How far (px) a window may sit from a requested rect and still count as there. */
  tolerance(): number
  /** A global point as the window's own CSS px (what its renderer positions things by). */
  toClient(win: CompositorWindow, point: Point): Point
  /** A window-relative CSS px point as a global point. */
  fromClient(win: CompositorWindow, point: Point): Point

  // Actions.
  /** The pointer, or null when the compositor cannot say. */
  cursor(): Promise<Point | null>
  /** Gets a not-yet-shown window onto `rect` before its first frame. Resolves when it is safe to show. */
  prepare(win: CompositorWindow, rect: Rect): Promise<void>
  /** Moves and resizes a window; resolves when the compositor confirms the rect (±1 px) or says why not. */
  place(win: CompositorWindow, rect: Rect): Promise<PlaceResult>
  /** Shows, unminimizes and focuses a window. */
  raise(win: CompositorWindow): Promise<void>
}

/** Rects the compositor reports are integers after rounding; clients round sizes too. */
export const RECT_TOLERANCE = 1

/**
 * A client sizes itself in whole DIP, so under a device scale S a window can
 * land up to about a DIP (S logical px) off the rect it was asked for, plus the
 * compositor's own rounding. Measured at S=1.5625: requested 1084x1588 mapped
 * at 1086x1590, 800x600 at 801x601.
 */
export const rectTolerance = (scale: number): number =>
  scale <= 1 ? RECT_TOLERANCE : Math.ceil(scale) + RECT_TOLERANCE

export function sameRect(a: Rect, b: Rect, tolerance = RECT_TOLERANCE): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}

/** Logical px to Electron DIP. */
export const toDip = (logical: number, scale: number): number => Math.round(logical / scale)
/** Electron DIP to logical px. */
export const fromDip = (dip: number, scale: number): number => Math.round(dip * scale)

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function distanceToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width))
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height))
  return Math.hypot(dx, dy)
}

export function monitorNearPoint(monitors: MonitorInfo[], p: Point): MonitorInfo | undefined {
  let best: MonitorInfo | undefined
  let bestD = Number.POSITIVE_INFINITY
  for (const m of monitors) {
    const d = distanceToRect(p, m.bounds)
    if (d < bestD) {
      best = m
      bestD = d
    }
  }
  return best
}

export function monitorForRect(monitors: MonitorInfo[], r: Rect): MonitorInfo | undefined {
  let best: MonitorInfo | undefined
  let bestArea = 0
  for (const m of monitors) {
    const area = overlap(r, m.bounds)
    if (area > bestArea) {
      best = m
      bestArea = area
    }
  }
  return best ?? monitorNearPoint(monitors, { x: r.x + r.width / 2, y: r.y + r.height / 2 })
}

function emitter() {
  const listeners = new Set<(change: CompositorChange) => void>()
  return {
    on(listener: (change: CompositorChange) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(change: CompositorChange): void {
      for (const listener of [...listeners]) {
        try {
          listener(change)
        } catch (error) {
          console.warn('[aico:compositor] listener failed:', error)
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Bridge backend.

export interface BridgeWindow {
  id: number
  pid: number
  title: string
  rect: Rect
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  focused: boolean
  workspace: number
  monitor: number
}

/** The fields a WindowChanged carries (a rect change carries the whole rect). */
export type BridgeWindowPatch = Partial<Omit<BridgeWindow, 'id' | 'pid'>>

export type BridgeSignal =
  | { type: 'opened'; window: BridgeWindow }
  | { type: 'closed'; id: number }
  | { type: 'changed'; id: number; fields: BridgeWindowPatch }
  | { type: 'monitors' }
  | { type: 'expectation'; expectationId: string; windowId: number; outcome: string }

/** The bridge's D-Bus interface, decoded. bridge-transport.ts implements it; tests fake it. */
export interface BridgeTransport {
  /** Starts watching the bus name: `up` whenever the bridge appears (or is there at start), `down` when it goes. */
  start(handlers: { up(): void; down(): void; signal(signal: BridgeSignal): void }): void
  stop(): void
  interfaceVersion(): Promise<number>
  list(): Promise<BridgeWindow[]>
  monitors(): Promise<MonitorInfo[]>
  moveResize(id: number, rect: Rect): Promise<void>
  activate(id: number): Promise<void>
  expect(pid: number, token: string, rect: Rect, timeoutMs: number): Promise<string>
  cancelExpect(expectationId: string): Promise<void>
  pointer(): Promise<Point>
}

/** The interface version this module speaks. */
export const BRIDGE_INTERFACE_VERSION = 1
/** A placement the compositor has not confirmed by then is given up on (a client may refuse a size). */
const PLACE_TIMEOUT_MS = 2000
/** A window that has not appeared by then lost its Expect. */
const EXPECT_TIMEOUT_MS = 15_000

interface Target {
  rect: Rect
  /** MoveResize was sent (or an Expect will place it); false = repair when it maps. */
  requested: boolean
  waiters: ((result: PlaceResult) => void)[]
  timer: ReturnType<typeof setTimeout>
}

interface Tracked {
  win: CompositorWindow
  token: string
  bridgeId?: number
  target?: Target
  /** The Expect in flight for this window, and the rect it will place it at. */
  expectationId?: string
  expectedRect?: Rect
}

interface BridgeDeps {
  transport: BridgeTransport
  /** The pid every Aico window reports (the Electron browser process). */
  pid: number
  /** Logical px per DIP. */
  scale(): number
  log?(message: string): void
}

export const windowToken = (winId: number): string => `[aico w${winId}]`

export function createBridgeCompositor(deps: BridgeDeps): Compositor {
  const { transport } = deps
  const log = deps.log ?? ((m) => console.log(`[aico:compositor] ${m}`))
  const events = emitter()
  const tracked = new Map<number, Tracked>()
  const bridgeWindows = new Map<number, BridgeWindow>()
  const expectations = new Map<string, number>()
  let monitorList: MonitorInfo[] = []
  let up = false
  let syncing = false
  let queued: BridgeSignal[] = []
  let generation = 0

  const tol = (): number => rectTolerance(deps.scale())
  const near = (a: Rect, b: Rect): boolean => sameRect(a, b, tol())

  const trackedByBridgeId = (id: number): Tracked | undefined => {
    for (const t of tracked.values()) if (t.bridgeId === id) return t
    return undefined
  }
  const actual = (t: Tracked): BridgeWindow | undefined =>
    t.bridgeId === undefined ? undefined : bridgeWindows.get(t.bridgeId)

  function settle(t: Tracked, result: PlaceResult): void {
    const target = t.target
    if (!target) return
    clearTimeout(target.timer)
    t.target = undefined
    for (const waiter of target.waiters) waiter(result)
  }

  function setTarget(t: Tracked, rect: Rect, requested: boolean, timeoutMs: number): Target {
    if (t.target) settle(t, { ok: false, error: 'superseded' })
    const target: Target = {
      rect,
      requested,
      waiters: [],
      timer: setTimeout(() => {
        if (t.target !== target) return
        log(`window ${t.win.id}: placement at ${rectText(rect)} not confirmed`)
        settle(t, { ok: false, error: PLACEMENT_UNCONFIRMED })
        events.emit({ kind: 'rect', winId: t.win.id })
      }, timeoutMs),
    }
    target.timer.unref?.()
    t.target = target
    return target
  }

  function request(t: Tracked, rect: Rect): void {
    if (t.bridgeId === undefined) return
    if (t.target) t.target.requested = true
    transport.moveResize(t.bridgeId, rect).catch((error: unknown) => {
      log(`window ${t.win.id}: MoveResize failed: ${errorText(error)}`)
      settle(t, { ok: false, error: PLACEMENT_FAILED })
      events.emit({ kind: 'rect', winId: t.win.id })
    })
  }

  /** The window reached its target: placement is done. */
  function checkTarget(t: Tracked): void {
    const bw = actual(t)
    if (t.target && bw && near(bw.rect, t.target.rect)) settle(t, { ok: true })
  }

  /** Mapped somewhere other than its target, and no Expect is going to put it there: place it now (the repair path). */
  function reconcile(t: Tracked, expectationEnded: boolean): boolean {
    const bw = actual(t)
    if (!t.target || !bw || near(bw.rect, t.target.rect)) return false
    const expectWillDoIt =
      !expectationEnded && t.expectationId && t.expectedRect && near(t.expectedRect, t.target.rect)
    if (expectWillDoIt) return false
    request(t, t.target.rect)
    return true
  }

  /** Match unbound windows to bridge windows by pid and token. */
  function bindAll(): void {
    for (const bw of bridgeWindows.values()) {
      if (bw.pid !== deps.pid || trackedByBridgeId(bw.id)) continue
      for (const t of tracked.values()) {
        if (t.bridgeId !== undefined || !bw.title.includes(t.token)) continue
        t.bridgeId = bw.id
        if (!reconcile(t, false)) checkTarget(t)
        events.emit({ kind: 'rect', winId: t.win.id })
        events.emit({ kind: 'state', winId: t.win.id })
        break
      }
    }
  }

  function apply(signal: BridgeSignal): void {
    switch (signal.type) {
      case 'opened': {
        bridgeWindows.set(signal.window.id, signal.window)
        bindAll()
        break
      }
      case 'closed': {
        const t = trackedByBridgeId(signal.id)
        bridgeWindows.delete(signal.id)
        if (t) {
          t.bridgeId = undefined
          settle(t, { ok: false, error: 'window_closed' })
        }
        break
      }
      case 'changed': {
        const bw = bridgeWindows.get(signal.id)
        if (!bw) return
        const f = signal.fields
        const moved = f.rect !== undefined
        const stateful = ['minimized', 'maximized', 'fullscreen', 'workspace', 'monitor'].some(
          (k) => k in f,
        )
        Object.assign(bw, f)
        const t = trackedByBridgeId(signal.id)
        if (f.title !== undefined) bindAll()
        if (!t) return
        if (moved) {
          checkTarget(t)
          events.emit({ kind: 'rect', winId: t.win.id })
        }
        if (stateful) events.emit({ kind: 'state', winId: t.win.id })
        break
      }
      case 'monitors':
        void refreshMonitors()
        break
      case 'expectation': {
        const winId = expectations.get(signal.expectationId)
        expectations.delete(signal.expectationId)
        const t = winId === undefined ? undefined : tracked.get(winId)
        if (!t) return
        t.expectationId = undefined
        if (signal.outcome !== 'placed') log(`window ${t.win.id}: expectation ${signal.outcome}`)
        // Placed at the Expect's rect (the client may have rounded the size):
        // that is the placement done. A later place() may want another rect.
        if (
          signal.outcome === 'placed' &&
          t.expectedRect &&
          t.target &&
          near(t.expectedRect, t.target.rect)
        )
          settle(t, { ok: true })
        else reconcile(t, true)
        break
      }
    }
  }

  async function refreshMonitors(): Promise<void> {
    try {
      monitorList = await transport.monitors()
      events.emit({ kind: 'monitors' })
    } catch (error) {
      log(`Monitors failed: ${errorText(error)}`)
    }
  }

  /** Reads the whole picture afresh: nothing is replayed when the bridge returns. */
  async function resync(): Promise<void> {
    const mine = ++generation
    syncing = true
    queued = []
    let ok = false
    try {
      const version = await transport.interfaceVersion()
      if (version !== BRIDGE_INTERFACE_VERSION) {
        log(`bridge interface version ${version}, expected ${BRIDGE_INTERFACE_VERSION}: not used`)
      } else {
        const [list, monitors] = await Promise.all([transport.list(), transport.monitors()])
        if (mine !== generation) return
        bridgeWindows.clear()
        for (const t of tracked.values()) t.bridgeId = undefined
        for (const bw of list) bridgeWindows.set(bw.id, bw)
        monitorList = monitors
        ok = true
      }
    } catch (error) {
      log(`bridge sync failed: ${errorText(error)}`)
    }
    if (mine !== generation) return
    syncing = false
    up = ok
    if (ok) {
      bindAll()
      for (const signal of queued) apply(signal)
      log(`bridge up: ${bridgeWindows.size} windows, ${monitorList.length} monitors`)
    }
    queued = []
    events.emit({ kind: 'availability' })
    events.emit({ kind: 'monitors' })
  }

  function lost(): void {
    generation++
    syncing = false
    queued = []
    if (up) log('bridge gone: window geometry is unavailable until it returns')
    up = false
    bridgeWindows.clear()
    monitorList = []
    expectations.clear()
    for (const t of tracked.values()) {
      t.bridgeId = undefined
      t.expectationId = undefined
      settle(t, { ok: false, error: COMPOSITOR_UNAVAILABLE })
    }
    events.emit({ kind: 'availability' })
  }

  const guess = (win: CompositorWindow): Rect => {
    if (win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const [w, h] = win.getSize()
    const s = deps.scale()
    // The size is Electron's; its position is not known (the compositor never tells a client).
    return { x: 0, y: 0, width: fromDip(w, s), height: fromDip(h, s) }
  }

  function bridgeBounds(win: CompositorWindow): Rect {
    const t = tracked.get(win.id)
    const bw = t && actual(t)
    return bw ? bw.rect : t?.target ? t.target.rect : guess(win)
  }

  return {
    backend: 'bridge',
    ready: () => up,
    start: () => {
      transport.start({
        up: () => void resync(),
        down: lost,
        signal: (signal) => {
          if (syncing) queued.push(signal)
          else if (up) apply(signal)
        },
      })
    },
    stop: () => {
      transport.stop()
      for (const t of tracked.values()) settle(t, { ok: false, error: COMPOSITOR_UNAVAILABLE })
    },
    attach: (win) => {
      const token = windowToken(win.id)
      tracked.set(win.id, { win, token })
      // The renderer's document.title would replace the token: keep it in every title.
      win.setTitle(`aico ${token}`)
      win.on('page-title-updated', (event, title) => {
        event.preventDefault()
        win.setTitle(`${title} ${token}`)
      })
      bindAll()
    },
    detach: (winId) => {
      const t = tracked.get(winId)
      if (!t) return
      settle(t, { ok: false, error: 'window_closed' })
      if (t.expectationId) {
        expectations.delete(t.expectationId)
        void transport.cancelExpect(t.expectationId).catch(() => {})
      }
      tracked.delete(winId)
    },
    onChange: events.on,

    bounds: (win) => {
      const t = tracked.get(win.id)
      if (t?.target) return t.target.rect
      const bw = t && actual(t)
      return bw ? bw.rect : guess(win)
    },
    isMinimized: (win) => {
      const t = tracked.get(win.id)
      const bw = t && actual(t)
      return bw ? bw.minimized : win.isMinimized()
    },
    isMaximized: (win) => {
      const t = tracked.get(win.id)
      const bw = t && actual(t)
      return bw ? bw.maximized : win.isMaximized()
    },
    isFocused: (win) => {
      const t = tracked.get(win.id)
      const bw = t && actual(t)
      return bw ? bw.focused : win.isFocused()
    },
    isPlacing: (win) => tracked.get(win.id)?.target !== undefined,
    monitors: () => monitorList,
    monitorFor: (rect) => monitorForRect(monitorList, rect),
    monitorNear: (point) => monitorNearPoint(monitorList, point),
    scale: () => deps.scale(),
    tolerance: tol,
    toClient: (win, point) => {
      const r = bridgeBounds(win)
      const s = deps.scale()
      return { x: (point.x - r.x) / s, y: (point.y - r.y) / s }
    },
    fromClient: (win, point) => {
      const r = bridgeBounds(win)
      const s = deps.scale()
      return { x: r.x + point.x * s, y: r.y + point.y * s }
    },

    cursor: async () => {
      if (!up) return null
      try {
        return await transport.pointer()
      } catch {
        return null
      }
    },
    prepare: async (win, rect) => {
      const t = tracked.get(win.id)
      if (!t || !up) return
      const s = deps.scale()
      // The size Chromium asks for first; the Expect then pins the exact rect.
      win.setSize(toDip(rect.width, s), toDip(rect.height, s))
      setTarget(t, rect, true, EXPECT_TIMEOUT_MS)
      try {
        const id = await transport.expect(deps.pid, t.token, rect, EXPECT_TIMEOUT_MS)
        if (tracked.get(win.id) === t) {
          t.expectationId = id
          t.expectedRect = rect
          expectations.set(id, win.id)
        } else void transport.cancelExpect(id).catch(() => {})
      } catch (error) {
        log(`window ${win.id}: Expect failed (${errorText(error)}); placing it after it maps`)
        if (t.target) t.target.requested = false
      }
    },
    place: (win, rect) => {
      const t = tracked.get(win.id)
      if (!up || !t) return Promise.resolve({ ok: false, error: COMPOSITOR_UNAVAILABLE })
      const bw = actual(t)
      if (bw && near(bw.rect, rect) && !t.target) return Promise.resolve({ ok: true })
      return new Promise<PlaceResult>((resolve) => {
        const target = setTarget(t, rect, bw !== undefined, PLACE_TIMEOUT_MS)
        target.waiters.push(resolve)
        if (bw) request(t, rect)
        else target.requested = false
      })
    },
    raise: async (win) => {
      if (win.isDestroyed()) return
      win.show()
      const t = tracked.get(win.id)
      if (up && t?.bridgeId !== undefined) {
        try {
          await transport.activate(t.bridgeId)
          return
        } catch (error) {
          log(`Activate failed: ${errorText(error)}`)
        }
      }
      if (!win.isDestroyed()) win.focus()
    },
  }
}

const rectText = (r: Rect): string => `${r.x},${r.y} ${r.width}x${r.height}`
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ---------------------------------------------------------------------------
// Native backend (X11): Electron's own calls.

type ScreenLike = Pick<
  Screen,
  | 'getAllDisplays'
  | 'getCursorScreenPoint'
  | 'getDisplayMatching'
  | 'getDisplayNearestPoint'
  | 'getPrimaryDisplay'
>

export function createNativeCompositor(deps: { screen: ScreenLike }): Compositor {
  const { screen } = deps
  const events = emitter()
  const info = (d: Electron.Display): MonitorInfo => ({
    id: String(d.id),
    primary: d.id === screen.getPrimaryDisplay().id,
    bounds: d.bounds,
    workArea: d.workArea,
    scale: d.scaleFactor,
  })
  return {
    backend: 'native',
    ready: () => true,
    start: () => {},
    stop: () => {},
    attach: (win) => {
      for (const kind of ['move', 'resize'] as const)
        win.on(kind as 'move', () => events.emit({ kind: 'rect', winId: win.id }))
      for (const kind of ['minimize', 'restore', 'maximize', 'unmaximize'] as const)
        win.on(kind as 'minimize', () => events.emit({ kind: 'state', winId: win.id }))
    },
    detach: () => {},
    onChange: events.on,
    bounds: (win) => win.getBounds(),
    isMinimized: (win) => win.isMinimized(),
    isMaximized: (win) => win.isMaximized(),
    isFocused: (win) => win.isFocused(),
    isPlacing: () => false,
    monitors: () => screen.getAllDisplays().map(info),
    monitorFor: (rect) => info(screen.getDisplayMatching(rect)),
    monitorNear: (point) => info(screen.getDisplayNearestPoint(point)),
    scale: () => 1,
    tolerance: () => RECT_TOLERANCE,
    toClient: (win, point) => {
      const r = win.getBounds()
      return { x: point.x - r.x, y: point.y - r.y }
    },
    fromClient: (win, point) => {
      const r = win.getBounds()
      return { x: r.x + point.x, y: r.y + point.y }
    },
    cursor: async () => screen.getCursorScreenPoint(),
    prepare: async (win, rect) => {
      win.setBounds(rect)
    },
    place: async (win, rect) => {
      win.setBounds(rect)
      return { ok: true }
    },
    raise: async (win) => {
      win.show()
      win.focus()
    },
  }
}
