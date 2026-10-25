import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type BridgeSignal,
  type BridgeTransport,
  type BridgeWindow,
  COMPOSITOR_UNAVAILABLE,
  type CompositorChange,
  type CompositorWindow,
  createBridgeCompositor,
  createNativeCompositor,
  fromDip,
  type MonitorInfo,
  monitorForRect,
  PLACEMENT_FAILED,
  PLACEMENT_UNCONFIRMED,
  type Rect,
  rectTolerance,
  sameRect,
  toDip,
  windowToken,
} from './compositor'

const PID = 4242
const MONITOR: MonitorInfo = {
  id: '0',
  primary: true,
  bounds: { x: 0, y: 0, width: 2000, height: 1000 },
  workArea: { x: 0, y: 28, width: 2000, height: 972 },
  scale: 1,
}
const SIDE: MonitorInfo = {
  id: '1',
  primary: false,
  bounds: { x: 2000, y: 0, width: 1000, height: 1000 },
  workArea: { x: 2000, y: 0, width: 1000, height: 1000 },
  scale: 1,
}

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
})

function bridgeWindow(
  id: number,
  winId: number,
  r: Rect,
  extra: Partial<BridgeWindow> = {},
): BridgeWindow {
  return {
    id,
    pid: PID,
    title: `aico ${windowToken(winId)}`,
    rect: r,
    minimized: false,
    maximized: false,
    fullscreen: false,
    focused: false,
    workspace: 0,
    monitor: 0,
    ...extra,
  }
}

function fakeTransport(
  initial: { windows?: BridgeWindow[]; monitors?: MonitorInfo[]; version?: number } = {},
) {
  const state = {
    windows: initial.windows ?? [],
    monitors: initial.monitors ?? [MONITOR],
    version: initial.version ?? 1,
    pointer: { x: 5, y: 6 },
  }
  let handlers!: Parameters<BridgeTransport['start']>[0]
  const calls = {
    moveResize: [] as { id: number; rect: Rect }[],
    activate: [] as number[],
    expect: [] as { pid: number; token: string; rect: Rect }[],
    cancel: [] as string[],
  }
  const failures = { moveResize: false, expect: false, activate: false }
  const transport: BridgeTransport = {
    start: (h) => {
      handlers = h
    },
    stop: vi.fn(),
    interfaceVersion: async () => state.version,
    list: async () => state.windows.map((w) => ({ ...w })),
    monitors: async () => state.monitors,
    moveResize: async (id, r) => {
      calls.moveResize.push({ id, rect: r })
      if (failures.moveResize) throw new Error('boom')
    },
    activate: async (id) => {
      calls.activate.push(id)
      if (failures.activate) throw new Error('boom')
    },
    expect: async (pid, token, r) => {
      calls.expect.push({ pid, token, rect: r })
      if (failures.expect) throw new Error('boom')
      return `e${calls.expect.length}`
    },
    cancelExpect: async (id) => {
      calls.cancel.push(id)
    },
    pointer: async () => state.pointer,
  }
  return {
    transport,
    state,
    calls,
    failures,
    up: () => handlers.up(),
    down: () => handlers.down(),
    signal: (s: BridgeSignal) => handlers.signal(s),
  }
}

function fakeWin(id: number, size: [number, number] = [900, 560]) {
  const listeners = new Map<string, (...args: never[]) => void>()
  const win = {
    id,
    size,
    title: '',
    destroyed: false,
    minimized: false,
    isDestroyed() {
      return this.destroyed
    },
    isMinimized() {
      return this.minimized
    },
    isMaximized: () => false,
    isFocused: () => false,
    getBounds: () => ({ x: 16, y: 10, width: 789, height: 497 }),
    getSize() {
      return this.size
    },
    setBounds: vi.fn(),
    setSize: vi.fn(function (this: { size: [number, number] }, w: number, h: number) {
      this.size = [w, h]
    }),
    setTitle: vi.fn(function (this: { title: string }, title: string) {
      this.title = title
    }),
    getTitle() {
      return this.title
    },
    show: vi.fn(),
    focus: vi.fn(),
    on: vi.fn((event: string, fn: (...args: never[]) => void) => {
      listeners.set(event, fn)
    }),
    emitTitle(title: string) {
      const event = { preventDefault: vi.fn() }
      ;(listeners.get('page-title-updated') as unknown as (e: unknown, t: string) => void)(
        event,
        title,
      )
      return event
    },
  }
  return win as typeof win & CompositorWindow
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function setup(o: Parameters<typeof fakeTransport>[0] = {}, scale = 1) {
  const bus = fakeTransport(o)
  const scaleRef = { value: scale }
  const log = vi.fn()
  const compositor = createBridgeCompositor({
    transport: bus.transport,
    pid: PID,
    scale: () => scaleRef.value,
    log,
  })
  const changes: CompositorChange[] = []
  compositor.onChange((c) => changes.push(c))
  compositor.start()
  return { ...bus, compositor, scaleRef, changes, log }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('units', () => {
  it('converts between logical px and DIP in one place', () => {
    expect(fromDip(800, 1.5625)).toBe(1250)
    expect(toDip(1250, 1.5625)).toBe(800)
    expect(toDip(fromDip(901, 1.5625), 1.5625)).toBe(901)
  })

  it('compares rects within one pixel', () => {
    expect(sameRect(rect(1, 1, 100, 100), rect(2, 0, 101, 99))).toBe(true)
    expect(sameRect(rect(1, 1, 100, 100), rect(3, 1, 100, 100))).toBe(false)
  })

  it('widens the tolerance to a DIP when the scale is fractional', () => {
    expect(rectTolerance(1)).toBe(1)
    expect(rectTolerance(1.5625)).toBe(3)
    expect(rectTolerance(2)).toBe(3)
  })

  it('finds the monitor holding most of a rect, else the nearest', () => {
    expect(monitorForRect([MONITOR, SIDE], rect(1900, 0, 400, 400))?.id).toBe('1')
    expect(monitorForRect([MONITOR, SIDE], rect(5000, 0, 100, 100))?.id).toBe('1')
    expect(monitorForRect([], rect(0, 0, 1, 1))).toBeUndefined()
  })
})

describe('bridge compositor: cache', () => {
  it('is not ready until the bridge has been read, and reads its windows then', async () => {
    const win = fakeWin(1)
    const { compositor, up, changes } = setup({
      windows: [bridgeWindow(7, 1, rect(100, 100, 1251, 801))],
    })
    compositor.attach(win)
    expect(compositor.ready()).toBe(false)
    expect(compositor.monitors()).toEqual([])
    up()
    await flush()
    expect(compositor.ready()).toBe(true)
    expect(compositor.bounds(win)).toEqual(rect(100, 100, 1251, 801))
    expect(compositor.monitors()).toEqual([MONITOR])
    expect(changes.map((c) => c.kind)).toContain('availability')
  })

  it('tags the title and keeps the token when the page retitles itself', () => {
    const win = fakeWin(12)
    const { compositor } = setup()
    compositor.attach(win)
    expect(win.setTitle).toHaveBeenCalledWith('aico [aico w12]')
    const event = win.emitTitle('Claude')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(win.title).toBe('Claude [aico w12]')
  })

  it('does not take another window with a longer id for its own', async () => {
    const one = fakeWin(1)
    const { compositor, up } = setup({ windows: [bridgeWindow(9, 12, rect(0, 0, 100, 100))] })
    compositor.attach(one)
    up()
    await flush()
    // Not bound: falls back to Electron's size guess at 0,0.
    expect(compositor.bounds(one)).toEqual(rect(0, 0, 900, 560))
  })

  it('ignores windows of other processes', async () => {
    const win = fakeWin(1)
    const { compositor, up } = setup({
      windows: [bridgeWindow(7, 1, rect(5, 5, 50, 50), { pid: 99 })],
    })
    compositor.attach(win)
    up()
    await flush()
    expect(compositor.bounds(win)).toEqual(rect(0, 0, 900, 560))
  })

  it('binds a window that opens later, and follows its changes', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal, changes } = setup()
    compositor.attach(win)
    up()
    await flush()
    changes.length = 0
    signal({ type: 'opened', window: bridgeWindow(7, 1, rect(10, 20, 300, 200)) })
    expect(compositor.bounds(win)).toEqual(rect(10, 20, 300, 200))
    signal({ type: 'changed', id: 7, fields: { rect: rect(11, 21, 301, 201) } })
    expect(compositor.bounds(win)).toEqual(rect(11, 21, 301, 201))
    signal({ type: 'changed', id: 7, fields: { minimized: true } })
    expect(compositor.isMinimized(win)).toBe(true)
    expect(changes.map((c) => c.kind)).toEqual(['rect', 'state', 'rect', 'state'])
    signal({ type: 'monitors' })
    signal({ type: 'closed', id: 7 })
    expect(compositor.bounds(win)).toEqual(rect(0, 0, 900, 560))
  })

  it('applies signals that arrived during the first read after it', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal, state } = setup({
      windows: [bridgeWindow(7, 1, rect(10, 20, 300, 200))],
    })
    compositor.attach(win)
    up()
    signal({ type: 'changed', id: 7, fields: { rect: rect(50, 60, 300, 200) } })
    await flush()
    expect(state.windows[0]?.rect).toEqual(rect(10, 20, 300, 200))
    expect(compositor.bounds(win)).toEqual(rect(50, 60, 300, 200))
  })

  it('degrades when the bridge goes and syncs afresh when it returns', async () => {
    const win = fakeWin(1)
    const { compositor, up, down, state, changes } = setup({
      windows: [bridgeWindow(7, 1, rect(10, 20, 300, 200))],
    })
    compositor.attach(win)
    up()
    await flush()
    changes.length = 0
    down()
    expect(compositor.ready()).toBe(false)
    expect(compositor.monitors()).toEqual([])
    expect(await compositor.place(win, rect(0, 0, 10, 10))).toEqual({
      ok: false,
      error: COMPOSITOR_UNAVAILABLE,
    })
    expect(await compositor.cursor()).toBeNull()
    expect(changes).toContainEqual({ kind: 'availability' })
    state.windows = [bridgeWindow(8, 1, rect(70, 80, 300, 200))]
    up()
    await flush()
    expect(compositor.ready()).toBe(true)
    expect(compositor.bounds(win)).toEqual(rect(70, 80, 300, 200))
  })

  it('refuses a bridge of another interface version', async () => {
    const { compositor, up, log } = setup({ version: 2 })
    up()
    await flush()
    expect(compositor.ready()).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('interface version 2'))
  })

  it('reports the pointer from the bridge', async () => {
    const { compositor, up } = setup()
    up()
    await flush()
    expect(await compositor.cursor()).toEqual({ x: 5, y: 6 })
  })

  it('maps points between global and window CSS px', async () => {
    const win = fakeWin(1)
    const { compositor, up } = setup(
      { windows: [bridgeWindow(7, 1, rect(100, 200, 1250, 800))] },
      1.5625,
    )
    compositor.attach(win)
    up()
    await flush()
    expect(compositor.toClient(win, { x: 100 + 1562.5, y: 200 + 156.25 })).toEqual({
      x: 1000,
      y: 100,
    })
    expect(compositor.fromClient(win, { x: 1000, y: 100 })).toEqual({ x: 1662.5, y: 356.25 })
  })

  it('reads minimized and focus from the window until it is bound', () => {
    const win = fakeWin(1)
    const { compositor } = setup()
    compositor.attach(win)
    win.minimized = true
    expect(compositor.isMinimized(win)).toBe(true)
  })
})

describe('bridge compositor: placement', () => {
  it('expects a new window at its rect before it shows, in logical px', async () => {
    const win = fakeWin(1)
    const { compositor, up, calls } = setup({}, 1.5625)
    compositor.attach(win)
    up()
    await flush()
    await compositor.prepare(win, rect(100, 50, 1250, 800))
    expect(win.setSize).toHaveBeenCalledWith(800, 512)
    expect(calls.expect).toEqual([{ pid: PID, token: '[aico w1]', rect: rect(100, 50, 1250, 800) }])
    expect(compositor.isPlacing(win)).toBe(true)
    // Until it maps, the target is where it is.
    expect(compositor.bounds(win)).toEqual(rect(100, 50, 1250, 800))
  })

  it('is done once the window maps within a pixel of the target, without any MoveResize', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal, calls } = setup()
    compositor.attach(win)
    up()
    await flush()
    await compositor.prepare(win, rect(100, 50, 1250, 800))
    signal({ type: 'opened', window: bridgeWindow(7, 1, rect(100, 50, 1251, 801)) })
    expect(compositor.isPlacing(win)).toBe(false)
    signal({ type: 'expectation', expectationId: 'e1', windowId: 7, outcome: 'placed' })
    expect(calls.moveResize).toEqual([])
    expect(compositor.bounds(win)).toEqual(rect(100, 50, 1251, 801))
  })

  it('counts a client-rounded size as placed, and settles when the expectation resolves', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal, calls } = setup({}, 1.5625)
    compositor.attach(win)
    up()
    await flush()
    await compositor.prepare(win, rect(1084, 32, 1672, 1588))
    // Chromium sizes in whole DIP: the window maps a couple of px bigger.
    signal({ type: 'opened', window: bridgeWindow(7, 1, rect(1084, 32, 1673, 1590)) })
    expect(compositor.isPlacing(win)).toBe(false)
    expect(calls.moveResize).toEqual([])
    expect(compositor.bounds(win)).toEqual(rect(1084, 32, 1673, 1590))
  })

  it('takes the expectation resolving as placed even when the size is further off', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal, calls } = setup()
    compositor.attach(win)
    up()
    await flush()
    await compositor.prepare(win, rect(0, 32, 542, 1048))
    // A minimum size keeps it wider than asked.
    signal({ type: 'opened', window: bridgeWindow(7, 1, rect(0, 32, 581, 1049)) })
    expect(compositor.isPlacing(win)).toBe(true)
    signal({ type: 'expectation', expectationId: 'e1', windowId: 7, outcome: 'placed' })
    expect(compositor.isPlacing(win)).toBe(false)
    expect(calls.moveResize).toEqual([])
  })

  it('moves a window that mapped somewhere else when the expectation did not place it', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal, calls } = setup()
    compositor.attach(win)
    up()
    await flush()
    await compositor.prepare(win, rect(100, 50, 1250, 800))
    signal({ type: 'opened', window: bridgeWindow(7, 1, rect(0, 0, 1250, 800)) })
    // The Expect is still pending: it will do it.
    expect(calls.moveResize).toEqual([])
    signal({ type: 'expectation', expectationId: 'e1', windowId: 7, outcome: 'timeout' })
    expect(calls.moveResize).toEqual([{ id: 7, rect: rect(100, 50, 1250, 800) }])
    signal({ type: 'changed', id: 7, fields: { rect: rect(100, 50, 1250, 800) } })
    expect(compositor.isPlacing(win)).toBe(false)
  })

  it('places at once when Expect is refused', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal, calls, failures } = setup()
    failures.expect = true
    compositor.attach(win)
    up()
    await flush()
    await compositor.prepare(win, rect(100, 50, 1250, 800))
    signal({ type: 'opened', window: bridgeWindow(7, 1, rect(0, 0, 1250, 800)) })
    expect(calls.moveResize).toEqual([{ id: 7, rect: rect(100, 50, 1250, 800) }])
  })

  it('place resolves when the compositor confirms the rect within a pixel', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal, calls } = setup({
      windows: [bridgeWindow(7, 1, rect(0, 0, 500, 400))],
    })
    compositor.attach(win)
    up()
    await flush()
    const placed = compositor.place(win, rect(40, 50, 600, 300))
    expect(calls.moveResize).toEqual([{ id: 7, rect: rect(40, 50, 600, 300) }])
    expect(compositor.isPlacing(win)).toBe(true)
    signal({ type: 'changed', id: 7, fields: { rect: rect(41, 50, 601, 299) } })
    expect(await placed).toEqual({ ok: true })
    expect(compositor.isPlacing(win)).toBe(false)
  })

  it('place is immediate when the window is already there', async () => {
    const win = fakeWin(1)
    const { compositor, up, calls } = setup({
      windows: [bridgeWindow(7, 1, rect(40, 50, 600, 300))],
    })
    compositor.attach(win)
    up()
    await flush()
    expect(await compositor.place(win, rect(41, 49, 600, 301))).toEqual({ ok: true })
    expect(calls.moveResize).toEqual([])
  })

  it('place gives up when the rect is never reached', async () => {
    const win = fakeWin(1)
    const { compositor, up, changes } = setup({
      windows: [bridgeWindow(7, 1, rect(0, 0, 500, 400))],
    })
    compositor.attach(win)
    up()
    await flush()
    const placed = compositor.place(win, rect(40, 50, 600, 300))
    changes.length = 0
    await vi.advanceTimersByTimeAsync(2000)
    expect(await placed).toEqual({ ok: false, error: PLACEMENT_UNCONFIRMED })
    expect(compositor.bounds(win)).toEqual(rect(0, 0, 500, 400))
    expect(changes).toContainEqual({ kind: 'rect', winId: 1 })
  })

  it('place reports a refused MoveResize', async () => {
    const win = fakeWin(1)
    const { compositor, up, failures } = setup({
      windows: [bridgeWindow(7, 1, rect(0, 0, 500, 400))],
    })
    failures.moveResize = true
    compositor.attach(win)
    up()
    await flush()
    expect(await compositor.place(win, rect(40, 50, 600, 300))).toEqual({
      ok: false,
      error: PLACEMENT_FAILED,
    })
  })

  it('a newer placement supersedes a pending one', async () => {
    const win = fakeWin(1)
    const { compositor, up, signal } = setup({
      windows: [bridgeWindow(7, 1, rect(0, 0, 500, 400))],
    })
    compositor.attach(win)
    up()
    await flush()
    const first = compositor.place(win, rect(10, 10, 300, 300))
    const second = compositor.place(win, rect(20, 20, 400, 400))
    expect(await first).toEqual({ ok: false, error: 'superseded' })
    signal({ type: 'changed', id: 7, fields: { rect: rect(20, 20, 400, 400) } })
    expect(await second).toEqual({ ok: true })
  })

  it('settles a pending placement with the explicit error when the bridge goes', async () => {
    const win = fakeWin(1)
    const { compositor, up, down } = setup({ windows: [bridgeWindow(7, 1, rect(0, 0, 500, 400))] })
    compositor.attach(win)
    up()
    await flush()
    const placed = compositor.place(win, rect(40, 50, 600, 300))
    down()
    expect(await placed).toEqual({ ok: false, error: COMPOSITOR_UNAVAILABLE })
    expect(compositor.isPlacing(win)).toBe(false)
  })

  it('cancels the expectation of a window that goes before it maps', async () => {
    const win = fakeWin(1)
    const { compositor, up, calls } = setup()
    compositor.attach(win)
    up()
    await flush()
    await compositor.prepare(win, rect(100, 50, 1250, 800))
    compositor.detach(1)
    expect(calls.cancel).toEqual(['e1'])
  })

  it('leaves prepare alone while the bridge is away', async () => {
    const win = fakeWin(1)
    const { compositor, calls } = setup()
    compositor.attach(win)
    await compositor.prepare(win, rect(100, 50, 1250, 800))
    expect(calls.expect).toEqual([])
    expect(compositor.isPlacing(win)).toBe(false)
  })
})

describe('bridge compositor: raise', () => {
  it('shows the window and activates it through the bridge', async () => {
    const win = fakeWin(1)
    const { compositor, up, calls } = setup({ windows: [bridgeWindow(7, 1, rect(0, 0, 500, 400))] })
    compositor.attach(win)
    up()
    await flush()
    await compositor.raise(win)
    expect(win.show).toHaveBeenCalled()
    expect(calls.activate).toEqual([7])
    expect(win.focus).not.toHaveBeenCalled()
  })

  it('falls back to Electron focus without the bridge or when Activate fails', async () => {
    const win = fakeWin(1)
    const { compositor, up, failures } = setup({
      windows: [bridgeWindow(7, 1, rect(0, 0, 500, 400))],
    })
    compositor.attach(win)
    await compositor.raise(win)
    expect(win.focus).toHaveBeenCalledTimes(1)
    up()
    await flush()
    failures.activate = true
    await compositor.raise(win)
    expect(win.focus).toHaveBeenCalledTimes(2)
  })
})

describe('native compositor', () => {
  const display = {
    id: 3,
    bounds: rect(0, 0, 1920, 1080),
    workArea: rect(0, 24, 1920, 1056),
    scaleFactor: 1,
  }
  const screen = {
    getAllDisplays: () => [display],
    getCursorScreenPoint: () => ({ x: 7, y: 8 }),
    getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display,
    getPrimaryDisplay: () => display,
  } as unknown as Parameters<typeof createNativeCompositor>[0]['screen']

  it('answers from Electron and is always ready', async () => {
    const compositor = createNativeCompositor({ screen })
    const win = fakeWin(1)
    expect(compositor.backend).toBe('native')
    expect(compositor.ready()).toBe(true)
    expect(compositor.bounds(win)).toEqual(rect(16, 10, 789, 497))
    expect(compositor.monitors()).toEqual([
      { id: '3', primary: true, bounds: display.bounds, workArea: display.workArea, scale: 1 },
    ])
    expect(compositor.monitorFor(rect(1, 1, 10, 10))?.id).toBe('3')
    expect(await compositor.cursor()).toEqual({ x: 7, y: 8 })
    expect(compositor.toClient(win, { x: 26, y: 20 })).toEqual({ x: 10, y: 10 })
    expect(await compositor.place(win, rect(1, 2, 3, 4))).toEqual({ ok: true })
    expect(win.setBounds).toHaveBeenCalledWith(rect(1, 2, 3, 4))
  })

  it('turns Electron window events into changes', () => {
    const compositor = createNativeCompositor({ screen })
    const win = fakeWin(1)
    const changes: CompositorChange[] = []
    compositor.onChange((c) => changes.push(c))
    compositor.attach(win)
    for (const [, fn] of win.on.mock.calls) (fn as () => void)()
    expect(changes.filter((c) => c.kind === 'rect')).toHaveLength(2)
    expect(changes.filter((c) => c.kind === 'state')).toHaveLength(4)
  })
})
