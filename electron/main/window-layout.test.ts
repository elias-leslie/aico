import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Rect } from './tiling'
import { createLayoutFile, createWindowLayout, layoutSnapshot } from './window-layout'
import { WindowRegistry } from './window-registry'

describe('layoutSnapshot', () => {
  it('lists windows column by column, top to bottom', () => {
    const w = (id: string, x: number, y: number) => ({
      id,
      name: id,
      bounds: { x, y, width: 100, height: 100 },
      displayId: '1',
      focused: false,
      visible: true,
      minimized: false,
      maximized: false,
      coordinator: false,
    })
    const owner = { pid: 4242, startTime: '987654' }
    const out = layoutSnapshot([], [w('c', 500, 0), w('b', 0, 400), w('a', 0, 0)], owner)
    expect(out.windows.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(out.v).toBe(1)
  })

  it('names the writing process so a reader can tell a crash leftover from a live Aico', () => {
    const now = new Date('2026-10-15T20:00:00.000Z')
    const out = layoutSnapshot([], [], { pid: 4242, startTime: '987654' }, now)
    expect(out).toMatchObject({
      v: 1,
      pid: 4242,
      startTime: '987654',
      updatedAt: now.toISOString(),
    })
    expect(layoutSnapshot([], [], { pid: 4242, startTime: null }).startTime).toBeNull()
  })
})

// The window and screen fakes the tiler and layout.json writer read.
function fakeWindow(id: number, bounds: Rect, o: { visible?: boolean; minimized?: boolean } = {}) {
  let current = bounds
  let destroyed = false
  return {
    id,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    isVisible: () => o.visible ?? true,
    isMinimized: () => o.minimized ?? false,
    isMaximized: () => false,
    getBounds: () => current,
    setBounds: vi.fn((b: Rect) => {
      current = b
    }),
  }
}
type FakeWindow = ReturnType<typeof fakeWindow>

const WORK_AREA = { x: 0, y: 0, width: 1024, height: 800 }
const display = {
  id: 1,
  bounds: WORK_AREA,
  workArea: WORK_AREA,
  scaleFactor: 1,
}
const fakeScreen = {
  getAllDisplays: () => [display],
  getCursorScreenPoint: () => ({ x: 10, y: 10 }),
  getDisplayMatching: () => display,
  getDisplayNearestPoint: () => display,
  getPrimaryDisplay: () => display,
}

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-layout-'))
  path = join(dir, 'aico', 'layout.json')
  vi.useFakeTimers({ now: 0 })
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('layout.json writing and removal at quit', () => {
  const owner = { pid: 4242, startTime: '777' }
  let quitting: boolean
  let ready: boolean
  let file: ReturnType<typeof createLayoutFile>
  beforeEach(() => {
    quitting = false
    ready = true
    file = createLayoutFile({
      path,
      owner,
      collect: () => ({ displays: [], windows: [] }),
      isReady: () => ready,
      isQuitting: () => quitting,
    })
  })

  it('removes layout.json at quit when this runtime wrote it', () => {
    file.writeNow()
    expect(existsSync(path)).toBe(true)
    file.stop({ removeFile: true })
    expect(existsSync(path)).toBe(false)
  })

  it('leaves a layout.json another Aico wrote', () => {
    mkdirSync(join(dir, 'aico'))
    writeFileSync(path, JSON.stringify({ pid: 9999 }))
    file.stop({ removeFile: true })
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(9999)
  })

  it('a launcher click (not the runtime owner) never removes it', () => {
    file.writeNow()
    file.stop({ removeFile: false })
    expect(existsSync(path)).toBe(true)
  })

  it('does not write after quit starts, and a pending write is dropped at stop', () => {
    file.scheduleWrite()
    file.stop({ removeFile: true })
    vi.advanceTimersByTime(2000)
    expect(existsSync(path)).toBe(false)
    quitting = true
    file.scheduleWrite()
    vi.advanceTimersByTime(2000)
    expect(existsSync(path)).toBe(false)
  })

  it('does nothing before ready', () => {
    ready = false
    file.scheduleWrite()
    vi.advanceTimersByTime(2000)
    expect(existsSync(path)).toBe(false)
  })

  it('writes once 300 ms after a burst settles, never later than 1 s after the first change', () => {
    for (const t of [0, 200, 400, 600]) {
      vi.setSystemTime(t)
      file.scheduleWrite()
      vi.advanceTimersByTime(200)
    }
    file.scheduleWrite() // t=800: only 200 ms left before the cap
    vi.advanceTimersByTime(199)
    expect(existsSync(path)).toBe(false)
    vi.advanceTimersByTime(1) // t=1000, not 1100
    expect(existsSync(path)).toBe(true)

    // A lone change after the burst settles waits the full 300 ms.
    rmSync(path)
    file.scheduleWrite()
    vi.advanceTimersByTime(299)
    expect(existsSync(path)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(existsSync(path)).toBe(true)
  })

  it('names the writing process', () => {
    file.writeNow()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      v: 1,
      pid: 4242,
      startTime: '777',
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('keeps going when the write fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dir, 'aico'), 'a file where the directory should be')
    expect(() => file.writeNow()).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[aico:layout] write failed:', expect.any(String))
    warn.mockRestore()
  })
})

describe('createWindowLayout: the tiler and the window picture', () => {
  function setup(windows: FakeWindow[], o: { coordinators?: string[] } = {}) {
    const all = [...windows]
    const registry = new WindowRegistry({
      fromId: (id) => (all.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
      fromWebContents: () => null,
      getAllWindows: () => all as unknown as BrowserWindow[],
    })
    for (const w of windows) registry.bindSession(w.id, `s${w.id}`)
    const coordinators = new Set(o.coordinators)
    const saveBounds = vi.fn()
    const state = { quitting: false, ready: true }
    const layout = createWindowLayout({
      registry,
      screen: fakeScreen as unknown as Parameters<typeof createWindowLayout>[0]['screen'],
      focusedWindow: () => (windows[0] ?? null) as unknown as BrowserWindow | null,
      isCoordinator: (id) => coordinators.has(id),
      sessionName: (id) => `name of ${id}`,
      saveBounds,
      isReady: () => state.ready,
      isQuitting: () => state.quitting,
      path,
      owner: { pid: 4242, startTime: '777' },
    })
    const win = (w: FakeWindow) => w as unknown as BrowserWindow
    return { layout, registry, saveBounds, state, coordinators, win, all }
  }

  it('places nothing before tiling is live', () => {
    const a = fakeWindow(1, { x: 500, y: 0, width: 300, height: 800 })
    const { layout } = setup([a])
    expect(layout.placeNew()).toBeNull()
    expect(a.setBounds).not.toHaveBeenCalled()
  })

  it('moves a neighbour aside and gives the new window the free slot', () => {
    const a = fakeWindow(1, { x: 500, y: 0, width: 300, height: 800 })
    const { layout, saveBounds } = setup([a])
    layout.enableTiling()
    expect(layout.placeNew()).toEqual({ x: 0, y: 0, width: 289, height: 800 })
    expect(a.setBounds).toHaveBeenCalledWith({ x: 735, y: 0, width: 289, height: 800 })
    expect(saveBounds).toHaveBeenCalledWith('s1', { x: 735, y: 0, width: 289, height: 800 }, '1')
    // Aico just resized it: its next terminal resize claims the tmux size.
    expect(layout.recentlyArranged(1)).toBe(true)
    vi.advanceTimersByTime(3001)
    expect(layout.recentlyArranged(1)).toBe(false)
  })

  it('leaves windows already in their slot alone', () => {
    const a = fakeWindow(1, { x: 289, y: 0, width: 446, height: 800 })
    const { layout, saveBounds } = setup([a])
    layout.retileDisplay(1)
    expect(a.setBounds).not.toHaveBeenCalled()
    expect(saveBounds).not.toHaveBeenCalled()
    layout.retileDisplay(99) // no such display
    expect(a.setBounds).not.toHaveBeenCalled()
  })

  it('re-tiles once when a coordinator mark changes, never on first sight', () => {
    const a = fakeWindow(1, { x: 0, y: 0, width: 289, height: 800 })
    const b = fakeWindow(2, { x: 735, y: 0, width: 289, height: 800 })
    const { layout, coordinators, win } = setup([a, b])
    layout.noteCoordinator(win(a), false)
    layout.noteCoordinator(win(b), false)
    layout.noteCoordinator(win(a), false)
    expect(a.setBounds).not.toHaveBeenCalled()
    expect(b.setBounds).not.toHaveBeenCalled()

    coordinators.add('s1')
    layout.noteCoordinator(win(a), true)
    expect(a.setBounds).toHaveBeenCalledWith({ x: 289, y: 0, width: 446, height: 800 })
    expect(b.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 289, height: 800 })
    layout.noteCoordinator(win(a), true)
    expect(a.setBounds).toHaveBeenCalledTimes(1)
    // The re-tile reaches layout.json too.
    vi.advanceTimersByTime(300)
    expect(JSON.parse(readFileSync(path, 'utf8')).windows[1]).toMatchObject({
      id: 's1',
      coordinator: true,
    })
  })

  it('does not re-tile while quitting', () => {
    const a = fakeWindow(1, { x: 0, y: 0, width: 289, height: 800 })
    const b = fakeWindow(2, { x: 735, y: 0, width: 289, height: 800 })
    const { layout, coordinators, state, win } = setup([a, b])
    layout.noteCoordinator(win(a), false)
    state.quitting = true
    coordinators.add('s1')
    layout.noteCoordinator(win(a), true)
    expect(a.setBounds).not.toHaveBeenCalled()
  })

  it('skips hidden and minimized windows when tiling', () => {
    const a = fakeWindow(1, { x: 500, y: 0, width: 300, height: 800 }, { minimized: true })
    const b = fakeWindow(2, { x: 500, y: 0, width: 300, height: 800 }, { visible: false })
    const { layout } = setup([a, b])
    layout.enableTiling()
    // Alone on screen: the new window takes the centre.
    expect(layout.placeNew()).toEqual({ x: 289, y: 0, width: 446, height: 800 })
    expect(a.setBounds).not.toHaveBeenCalled()
    expect(b.setBounds).not.toHaveBeenCalled()
  })

  it('an agent position sets the bounds and remembers them', () => {
    const a = fakeWindow(1, { x: 0, y: 0, width: 289, height: 800 })
    const { layout, saveBounds, win } = setup([a])
    const bounds = { x: 10, y: 20, width: 400, height: 300 }
    layout.arrange(win(a), bounds)
    expect(a.setBounds).toHaveBeenCalledWith(bounds)
    expect(saveBounds).toHaveBeenCalledWith('s1', bounds, '1')
    expect(layout.recentlyArranged(1)).toBe(true)
    layout.forget(1)
    expect(layout.recentlyArranged(1)).toBe(false)
  })

  it('persists only windows bound to a session and still open', () => {
    const a = fakeWindow(1, { x: 0, y: 0, width: 289, height: 800 })
    const stray = fakeWindow(7, { x: 0, y: 0, width: 289, height: 800 })
    const { layout, saveBounds, win } = setup([a])
    layout.persist(win(stray))
    a.destroy()
    layout.persist(win(a))
    expect(saveBounds).not.toHaveBeenCalled()
  })

  it('writes every session window with its name, display and state', () => {
    const a = fakeWindow(1, { x: 0, y: 0, width: 289, height: 800 })
    const b = fakeWindow(2, { x: 735, y: 0, width: 289, height: 800 }, { minimized: true })
    const { layout, all } = setup([a, b])
    all.push(fakeWindow(9, { x: 0, y: 0, width: 10, height: 10 })) // not a session window
    layout.scheduleWrite()
    vi.advanceTimersByTime(300)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.displays).toEqual([
      { id: '1', primary: true, bounds: WORK_AREA, workArea: WORK_AREA, scaleFactor: 1 },
    ])
    expect(written.windows).toEqual([
      {
        id: 's1',
        name: 'name of s1',
        bounds: { x: 0, y: 0, width: 289, height: 800 },
        displayId: '1',
        focused: true,
        visible: true,
        minimized: false,
        maximized: false,
        coordinator: false,
      },
      expect.objectContaining({ id: 's2', focused: false, minimized: true }),
    ])
    layout.stop({ removeFile: true })
    expect(existsSync(path)).toBe(false)
  })
})
