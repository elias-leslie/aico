import type { BrowserWindow } from 'electron'
import type { SessionDescriptor } from 'tether/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERSONAL_WORKSPACE_ID } from './project'
import type { ViewRow } from './views'
import { WindowRegistry } from './window-registry'
import { createWindows } from './windows'

type Listener = (...args: unknown[]) => void

// A BrowserWindow stand-in that records its options and listeners.
class FakeWindow {
  static all: FakeWindow[] = []
  static nextId = 1
  static fromId(id: number): FakeWindow | null {
    return FakeWindow.all.find((w) => w.id === id) ?? null
  }
  static getAllWindows(): FakeWindow[] {
    return FakeWindow.all.filter((w) => !w.destroyed)
  }

  readonly id = FakeWindow.nextId++
  destroyed = false
  visible = true
  minimized = false
  bounds: { x: number; y: number; width: number; height: number }
  readonly listeners = new Map<string, Listener[]>()
  readonly contentListeners = new Map<string, Listener[]>()
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly loadURL = vi.fn()
  readonly loadFile = vi.fn()
  readonly reload = vi.fn()
  readonly webContents = {
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: (event: string, fn: Listener) => {
      this.contentListeners.set(event, [...(this.contentListeners.get(event) ?? []), fn])
    },
  }

  constructor(readonly options: Record<string, unknown>) {
    this.bounds = {
      x: (options.x as number) ?? 0,
      y: (options.y as number) ?? 0,
      width: options.width as number,
      height: options.height as number,
    }
    FakeWindow.all.push(this)
  }
  on(event: string, fn: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
  }
  emit(event: string): void {
    for (const fn of this.listeners.get(event) ?? []) fn()
  }
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  isMinimized = () => this.minimized
  getBounds = () => this.bounds
  destroy = () => {
    this.destroyed = true
  }
}

const view = (id: string, open = false, seq = 1): ViewRow => ({
  id,
  seq,
  bounds: null,
  displayId: null,
  open,
  nameOverride: null,
  coordinator: false,
})

function setup(o: { views?: ViewRow[]; live?: string[]; catalog?: string[] } = {}) {
  const calls: string[] = []
  const rows = new Map((o.views ?? []).map((v) => [v.id, v]))
  const live = new Set(o.live ?? [])
  const state = { quitting: false }
  const registry = new WindowRegistry({
    fromId: (id) => FakeWindow.fromId(id) as unknown as BrowserWindow | null,
    fromWebContents: () => null,
    getAllWindows: () => FakeWindow.getAllWindows() as unknown as BrowserWindow[],
    getFocusedWindow: () => null,
  })
  const forget = registry.forget
  registry.forget = (winId) => {
    calls.push(`registry.forget ${winId}`)
    forget(winId)
  }
  const layout = {
    placeNew: vi.fn((): null => null),
    persist: vi.fn((win: BrowserWindow) => calls.push(`persist ${win.id}`)),
    scheduleWrite: vi.fn(),
    retileDisplay: vi.fn((id: number) => calls.push(`retile ${id}`)),
  }
  const views = {
    ensureView: vi.fn((id: string, open = false) => {
      calls.push(`ensureView ${id} ${open}`)
      const row = rows.get(id) ?? view(id, open)
      rows.set(id, row)
      return row
    }),
    setOpen: vi.fn((id: string, open: boolean) => calls.push(`setOpen ${id} ${open}`)),
    getView: (id: string) => rows.get(id),
    listViews: () => [...rows.values()],
  }
  const hooks = {
    loaded: vi.fn(),
    focused: vi.fn(),
    blurred: vi.fn(),
    visibility: vi.fn(),
    disposing: vi.fn((winId: number) => {
      calls.push(`disposing ${winId} bound=${registry.sessionOf(winId) ?? '-'}`)
    }),
    changed: vi.fn(),
  }
  const upsert = vi.fn((d: SessionDescriptor) => calls.push(`upsert ${d.id}`))
  const display = { id: 7, workArea: { x: 0, y: 0, width: 1000, height: 800 } }
  const windows = createWindows({
    registry,
    layout,
    views,
    screen: { getAllDisplays: () => [display], getDisplayMatching: () => display },
    isLive: (id: string) => live.has(id),
    upsert,
    catalogList: () => (o.catalog ?? []).map((id) => ({ id }) as SessionDescriptor),
    isQuitting: () => state.quitting,
    hooks,
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: vi.fn() },
  } as unknown as Parameters<typeof createWindows>[0])
  const only = () => {
    expect(FakeWindow.all).toHaveLength(1)
    return FakeWindow.all[0] as FakeWindow
  }
  return { windows, registry, layout, views, hooks, upsert, calls, state, only }
}

beforeEach(() => {
  FakeWindow.all = []
  FakeWindow.nextId = 1
})
afterEach(() => {
  vi.useRealTimers()
})

describe('windows: opening', () => {
  it('opens a session window, binds it and marks its view open', () => {
    const { windows, registry, views, hooks, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    expect(registry.sessionOf(win.id)).toBe('aaaaaaaa')
    expect(views.setOpen).toHaveBeenCalledWith('aaaaaaaa', true)
    expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer\/index\.html$/))
    expect(win.options).toMatchObject({
      width: 900,
      height: 560,
      frame: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    })
    expect(hooks.changed).toHaveBeenCalledTimes(1)
  })

  it('focuses an open window instead of opening another', () => {
    const { windows, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('tiles a new window in, or restores at the remembered place on restore', () => {
    const remembered = {
      ...view('aaaaaaaa', true),
      bounds: { x: 5, y: 6, width: 700, height: 500 },
    }
    const { windows, layout } = setup({ views: [remembered], live: ['aaaaaaaa'] })
    layout.placeNew.mockReturnValue({ x: 1, y: 2, width: 3, height: 4 } as never)
    windows.restoreOnLaunch()
    expect(layout.placeNew).not.toHaveBeenCalled()
    expect(FakeWindow.all[0]?.options).toMatchObject({ x: 5, y: 6, width: 700, height: 500 })
    windows.openNew('shell', 'p')
    expect(FakeWindow.all[1]?.options).toMatchObject({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('opens a new session window as a pending create', () => {
    const { windows, registry, only } = setup()
    windows.openNew('claude', 'proj')
    expect(registry.pending(only().id)).toEqual({ tool: 'claude', projectId: 'proj' })
  })

  it('binds a created session in order: catalog, registry, view, open, bounds', () => {
    const { windows, registry, calls, only } = setup()
    windows.openNew('shell', 'p')
    const win = only()
    calls.length = 0
    windows.bind(win as unknown as BrowserWindow, { id: 'bbbbbbbb' } as SessionDescriptor)
    expect(calls).toEqual([
      'upsert bbbbbbbb',
      'ensureView bbbbbbbb true',
      'setOpen bbbbbbbb true',
      `persist ${win.id}`,
    ])
    expect(registry.sessionOf(win.id)).toBe('bbbbbbbb')
    expect(registry.pending(win.id)).toBeUndefined()
  })
})

describe('windows: focus and blur', () => {
  it('runs the focus hook before telling the renderer, and blur after', () => {
    const { windows, hooks, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    const order: string[] = []
    hooks.focused.mockImplementation((_w: unknown, id: unknown) => order.push(`hook ${id}`))
    hooks.blurred.mockImplementation(() => order.push('blur hook'))
    win.webContents.send.mockImplementation((channel: string, on: boolean) =>
      order.push(`${channel} ${on}`),
    )
    win.emit('focus')
    win.emit('blur')
    expect(order).toEqual(['hook aaaaaaaa', 'win:focus true', 'win:focus false', 'blur hook'])
  })

  it('tells the root when the window is shown, hidden, minimized or restored', () => {
    const { windows, hooks, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    for (const change of ['show', 'hide', 'minimize', 'restore', 'move', 'focus']) win.emit(change)
    expect(hooks.visibility).toHaveBeenCalledTimes(4)
    expect(hooks.visibility).toHaveBeenCalledWith(win)
  })

  it('tells the root when the renderer has loaded', () => {
    const { windows, hooks, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    for (const fn of win.contentListeners.get('did-finish-load') ?? []) fn()
    expect(hooks.loaded).toHaveBeenCalledWith(win)
  })
})

describe('windows: renderer gone', () => {
  const gone = (win: FakeWindow, reason = 'oom') => {
    for (const fn of win.contentListeners.get('render-process-gone') ?? [])
      fn({}, { reason, exitCode: 9 })
  }

  it('reloads a window whose renderer died, at most once per 10 s', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { windows, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    gone(win)
    expect(win.reload).toHaveBeenCalledTimes(1)
    // Dies again at once: the next reload waits for the 10 s mark, and further
    // deaths in the meantime add nothing.
    vi.advanceTimersByTime(2_000)
    gone(win, 'crashed')
    gone(win, 'killed')
    vi.advanceTimersByTime(7_999)
    expect(win.reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(win.reload).toHaveBeenCalledTimes(2)
    // Quiet for longer than 10 s: the next death reloads at once.
    vi.advanceTimersByTime(30_000)
    gone(win)
    expect(win.reload).toHaveBeenCalledTimes(3)
  })

  it('does not reload after a clean exit, while quitting, or once the window is gone', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { windows, state, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    gone(win, 'clean-exit')
    expect(win.reload).not.toHaveBeenCalled()
    gone(win)
    gone(win) // waits for the 10 s mark
    win.emit('closed')
    vi.advanceTimersByTime(20_000)
    expect(win.reload).toHaveBeenCalledTimes(1)
    state.quitting = true
    gone(win)
    expect(win.reload).toHaveBeenCalledTimes(1)
  })
})

describe('windows: closing', () => {
  it('disposes before the registry forgets, re-tiles the screen and marks the view closed', () => {
    const { windows, calls, hooks, layout, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    calls.length = 0
    win.emit('close')
    win.emit('closed')
    expect(calls).toEqual([
      `persist ${win.id}`,
      `disposing ${win.id} bound=aaaaaaaa`,
      `registry.forget ${win.id}`,
      'retile 7',
      'setOpen aaaaaaaa false',
    ])
    expect(layout.scheduleWrite).toHaveBeenCalled()
    expect(hooks.changed).toHaveBeenCalledTimes(2)
  })

  it('on quit leaves the view open and the others in place', () => {
    const { windows, calls, state, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    calls.length = 0
    state.quitting = true
    win.emit('close')
    win.emit('closed')
    expect(calls).toEqual([
      `persist ${win.id}`,
      `disposing ${win.id} bound=aaaaaaaa`,
      `registry.forget ${win.id}`,
    ])
  })

  it('does not re-tile for a hidden or minimized window', () => {
    const { windows, calls, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    win.minimized = true
    win.emit('close')
    win.emit('closed')
    expect(calls).not.toContain('retile 7')
  })

  it('drops a pending bounds save when the window closes', () => {
    vi.useFakeTimers()
    const { windows, layout, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    win.emit('move')
    win.emit('closed')
    layout.persist.mockClear()
    vi.advanceTimersByTime(1000)
    expect(layout.persist).not.toHaveBeenCalled()
  })

  it('saves bounds 400 ms after the last move', () => {
    vi.useFakeTimers()
    const { windows, layout, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    win.emit('move')
    vi.advanceTimersByTime(300)
    win.emit('resize')
    vi.advanceTimersByTime(399)
    expect(layout.persist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(layout.persist).toHaveBeenCalledTimes(1)
  })

  it('closes an ended session window and re-tiles on the next tick', async () => {
    const { windows, layout, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    const win = only()
    windows.closeEnded('aaaaaaaa')
    expect(win.destroyed).toBe(true)
    expect(layout.retileDisplay).not.toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(layout.retileDisplay).toHaveBeenCalledWith(7)
  })

  it('closes an ended session window without re-tiling while quitting', async () => {
    const { windows, layout, state } = setup()
    windows.focusOrReopen('aaaaaaaa')
    state.quitting = true
    windows.closeEnded('aaaaaaaa')
    windows.closeEnded('bbbbbbbb') // no window: nothing to do
    await new Promise((resolve) => setImmediate(resolve))
    expect(layout.retileDisplay).not.toHaveBeenCalled()
  })

  it('destroys a window whose session left the list', () => {
    const { windows, only } = setup()
    windows.focusOrReopen('aaaaaaaa')
    windows.destroyFor('aaaaaaaa')
    expect(only().destroyed).toBe(true)
  })
})

describe('windows: restore and activation', () => {
  it('reopens only live views that were open', () => {
    const { windows, registry } = setup({
      views: [view('aaaaaaaa', true), view('bbbbbbbb', true), view('cccccccc', false)],
      live: ['aaaaaaaa', 'cccccccc'],
    })
    windows.restoreOnLaunch()
    expect(FakeWindow.all.map((w) => registry.sessionOf(w.id))).toEqual(['aaaaaaaa'])
    windows.restoreOnLaunch() // already open: no second window
    expect(FakeWindow.all).toHaveLength(1)
  })

  it('brings back the oldest live view when none was open and no window exists', () => {
    const { windows, registry, only } = setup({
      views: [view('aaaaaaaa'), view('bbbbbbbb')],
      live: ['bbbbbbbb'],
    })
    windows.restoreOnLaunch()
    expect(registry.sessionOf(only().id)).toBe('bbbbbbbb')
  })

  it('activation shows every window and focuses the first', () => {
    const { windows } = setup()
    windows.focusOrReopen('aaaaaaaa')
    windows.focusOrReopen('bbbbbbbb')
    windows.activate()
    expect(FakeWindow.all.map((w) => w.show.mock.calls.length)).toEqual([1, 1])
    expect(FakeWindow.all[0]?.focus).toHaveBeenCalled()
    windows.showAll()
    expect(FakeWindow.all.map((w) => w.show.mock.calls.length)).toEqual([2, 2])
  })

  it('activation with no window opens the oldest live view', () => {
    const { windows, registry, only } = setup({ views: [view('aaaaaaaa')], live: ['aaaaaaaa'] })
    windows.activate()
    expect(registry.sessionOf(only().id)).toBe('aaaaaaaa')
  })

  it('activation with no view opens a listed session', () => {
    const { windows, registry, only } = setup({ catalog: ['dddddddd'] })
    windows.activate()
    expect(registry.sessionOf(only().id)).toBe('dddddddd')
  })

  it('activation with nothing at all opens a new shell in the Personal Workspace', () => {
    const { windows, registry, only } = setup()
    windows.activate()
    expect(registry.pending(only().id)).toEqual({
      tool: 'shell',
      projectId: PERSONAL_WORKSPACE_ID,
    })
  })
})
