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
import { fakeCompositor } from './compositor.fake'
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

// The window fake and the compositor state the tiler and layout.json writer read.
function fakeWindow(id: number, o: { visible?: boolean } = {}) {
  let destroyed = false
  return {
    id,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    isVisible: () => o.visible ?? true,
  }
}
type FakeWindow = ReturnType<typeof fakeWindow>

const WORK_AREA = { x: 0, y: 0, width: 1024, height: 800 }

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
      collect: () => ({ displays: [], windows: [], boundsReliable: true }),
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
  type Spec = { win: FakeWindow; rect: Rect; minimized?: boolean }
  const spec = (
    id: number,
    rect: Rect,
    o: { visible?: boolean; minimized?: boolean } = {},
  ): Spec => ({ win: fakeWindow(id, o), rect, minimized: o.minimized })

  function setup(
    specs: Spec[],
    o: { coordinators?: string[]; ready?: boolean; cursor?: { x: number; y: number } | null } = {},
  ) {
    const comp = fakeCompositor({ ready: o.ready, cursor: o.cursor })
    const all = specs.map((x) => x.win)
    for (const x of specs) {
      comp.rects.set(x.win.id, x.rect)
      if (x.minimized) comp.minimized.add(x.win.id)
    }
    const registry = new WindowRegistry({
      fromId: (id) => (all.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
      fromWebContents: () => null,
      getAllWindows: () => all as unknown as BrowserWindow[],
      getFocusedWindow: () => (all[0] ?? null) as unknown as BrowserWindow | null,
    })
    for (const w of all) registry.bindSession(w.id, `s${w.id}`)
    const coordinators = new Set(o.coordinators)
    const saveBounds = vi.fn()
    const state = { quitting: false, ready: true }
    const layout = createWindowLayout({
      registry,
      compositor: comp.compositor,
      isCoordinator: (id) => coordinators.has(id),
      sessionName: (id) => `name of ${id}`,
      saveBounds,
      isReady: () => state.ready,
      isQuitting: () => state.quitting,
      path,
      owner: { pid: 4242, startTime: '777' },
    })
    const win = (w: FakeWindow) => w as unknown as BrowserWindow
    return { layout, comp, registry, saveBounds, state, coordinators, win, all }
  }

  const rect = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  })

  it('collects live bounds without writing a file, and refuses before ready or during quit', () => {
    const { layout, state, comp, all } = setup([spec(1, WORK_AREA)])
    expect(layout.snapshot()).toMatchObject({
      v: 1,
      pid: 4242,
      boundsReliable: true,
      windows: [{ id: 's1', bounds: WORK_AREA }],
    })
    const moved = { ...WORK_AREA, x: 73 }
    comp.rects.set(all[0]?.id ?? 0, moved)
    expect(layout.snapshot()?.windows[0]?.bounds).toEqual(moved)
    expect(existsSync(path)).toBe(false)
    state.ready = false
    expect(layout.snapshot()).toBeNull()
    state.ready = true
    state.quitting = true
    expect(layout.snapshot()).toBeNull()
  })

  it('marks the layout unreliable while the compositor cannot say where windows are', () => {
    const { layout } = setup([spec(1, WORK_AREA)], { ready: false })
    const snapshot = layout.snapshot()
    expect(snapshot?.boundsReliable).toBe(false)
    expect(snapshot?.displays).toEqual([])
  })

  it('places nothing before tiling is live', async () => {
    const a = spec(1, rect(500, 0, 300, 800))
    const { layout, comp } = setup([a])
    const fresh = fakeWindow(2)
    await layout.present(fresh as unknown as BrowserWindow, { tile: true, saved: null })
    expect(comp.prepare).not.toHaveBeenCalled()
    expect(comp.place).not.toHaveBeenCalled()
  })

  it('a window with a saved place and no tiling goes there', async () => {
    const { layout, comp } = setup([])
    const fresh = fakeWindow(2)
    const saved = rect(40, 50, 600, 400)
    await layout.present(fresh as unknown as BrowserWindow, { tile: false, saved })
    expect(comp.prepare).toHaveBeenCalledWith(fresh, saved)
  })

  it('moves a neighbour aside and gives the new window the free slot', async () => {
    const a = spec(1, rect(500, 0, 300, 800))
    const { layout, comp, saveBounds } = setup([a])
    layout.enableTiling()
    const fresh = fakeWindow(2)
    await layout.present(fresh as unknown as BrowserWindow, { tile: true, saved: null })
    expect(comp.prepare).toHaveBeenCalledWith(fresh, rect(0, 0, 289, 800))
    expect(comp.place).toHaveBeenCalledWith(a.win, rect(735, 0, 289, 800))
    expect(saveBounds).toHaveBeenCalledWith('s1', rect(735, 0, 289, 800), '1')
    // Aico just resized it: its next terminal resize claims the tmux size.
    expect(layout.recentlyArranged(1)).toBe(true)
    vi.advanceTimersByTime(3001)
    expect(layout.recentlyArranged(1)).toBe(false)
  })

  it('tiles on the screen under the pointer and sees windows still opening', async () => {
    const { layout, comp, all, registry } = setup([])
    layout.enableTiling()
    const first = fakeWindow(1, { visible: false })
    const second = fakeWindow(2, { visible: false })
    // Both are bound to their sessions by the time their turn comes.
    all.push(first, second)
    registry.bindSession(1, 's1')
    registry.bindSession(2, 's2')
    // Opened together: neither is visible yet, but each one's slot is taken in turn.
    await Promise.all([
      layout.present(first as unknown as BrowserWindow, { tile: true, saved: null }),
      layout.present(second as unknown as BrowserWindow, { tile: true, saved: null }),
    ])
    const slots = comp.prepare.mock.calls.map(([, r]) => r)
    expect(slots).toHaveLength(2)
    expect(slots[0]).not.toEqual(slots[1])
  })

  it('leaves windows already in their slot alone, within a pixel', () => {
    const a = spec(1, rect(289, 0, 446, 800))
    const { layout, comp, saveBounds } = setup([a])
    layout.retileDisplay('1')
    expect(comp.place).not.toHaveBeenCalled()
    expect(saveBounds).not.toHaveBeenCalled()
    // Device-scale rounding leaves a window a pixel off its tile: that is in place.
    comp.rects.set(1, rect(290, -1, 445, 801))
    layout.retileDisplay('1')
    expect(comp.place).not.toHaveBeenCalled()
    layout.retileDisplay('99') // no such display
    expect(comp.place).not.toHaveBeenCalled()
  })

  it('does not tile, and keeps remembered places, while the compositor is unavailable', async () => {
    const a = spec(1, rect(500, 0, 300, 800))
    const { layout, comp, saveBounds } = setup([a], { ready: false })
    layout.enableTiling()
    const fresh = fakeWindow(2)
    const saved = rect(1, 2, 300, 200)
    await layout.present(fresh as unknown as BrowserWindow, { tile: true, saved })
    expect(comp.prepare).toHaveBeenCalledWith(fresh, saved) // size only, the compositor places it
    layout.retileDisplay('1')
    layout.persist(a.win as unknown as BrowserWindow)
    expect(comp.place).not.toHaveBeenCalled()
    expect(saveBounds).not.toHaveBeenCalled()
  })

  it('re-tiles once when a coordinator mark changes, never on first sight', () => {
    const a = spec(1, rect(0, 0, 289, 800))
    const b = spec(2, rect(735, 0, 289, 800))
    const { layout, coordinators, win, comp } = setup([a, b])
    layout.noteCoordinator(win(a.win), false)
    layout.noteCoordinator(win(b.win), false)
    layout.noteCoordinator(win(a.win), false)
    expect(comp.place).not.toHaveBeenCalled()

    coordinators.add('s1')
    layout.noteCoordinator(win(a.win), true)
    expect(comp.place).toHaveBeenCalledWith(a.win, rect(289, 0, 446, 800))
    expect(comp.place).toHaveBeenCalledWith(b.win, rect(0, 0, 289, 800))
    layout.noteCoordinator(win(a.win), true)
    expect(comp.place).toHaveBeenCalledTimes(2)
    // The re-tile reaches layout.json too.
    vi.advanceTimersByTime(300)
    expect(JSON.parse(readFileSync(path, 'utf8')).windows[1]).toMatchObject({
      id: 's1',
      coordinator: true,
    })
  })

  it('does not re-tile while quitting', () => {
    const a = spec(1, rect(0, 0, 289, 800))
    const b = spec(2, rect(735, 0, 289, 800))
    const { layout, coordinators, state, win, comp } = setup([a, b])
    layout.noteCoordinator(win(a.win), false)
    state.quitting = true
    coordinators.add('s1')
    layout.noteCoordinator(win(a.win), true)
    expect(comp.place).not.toHaveBeenCalled()
  })

  it('skips hidden and minimized windows when tiling', async () => {
    const a = spec(1, rect(500, 0, 300, 800), { minimized: true })
    const b = spec(2, rect(500, 0, 300, 800), { visible: false })
    const { layout, comp } = setup([a, b])
    layout.enableTiling()
    const fresh = fakeWindow(3)
    await layout.present(fresh as unknown as BrowserWindow, { tile: true, saved: null })
    // Alone on screen: the new window takes the centre.
    expect(comp.prepare).toHaveBeenCalledWith(fresh, rect(289, 0, 446, 800))
    expect(comp.place).not.toHaveBeenCalled()
  })

  it('an agent position places the window and remembers the bounds once it is there', async () => {
    const a = spec(1, rect(0, 0, 289, 800))
    const { layout, saveBounds, win, comp } = setup([a])
    const bounds = rect(10, 20, 400, 300)
    await expect(layout.arrange(win(a.win), bounds)).resolves.toEqual({ ok: true })
    expect(comp.place).toHaveBeenCalledWith(a.win, bounds)
    expect(saveBounds).toHaveBeenCalledWith('s1', bounds, '1')
    expect(layout.recentlyArranged(1)).toBe(true)
    layout.forget(1)
    expect(layout.recentlyArranged(1)).toBe(false)
  })

  it('an agent position is an explicit error without the compositor, or when it is refused', async () => {
    const a = spec(1, rect(0, 0, 289, 800))
    const down = setup([a], { ready: false })
    await expect(down.layout.arrange(down.win(a.win), rect(10, 20, 400, 300))).resolves.toEqual({
      ok: false,
      error: 'compositor_unavailable',
    })
    expect(down.saveBounds).not.toHaveBeenCalled()

    const b = spec(1, rect(0, 0, 289, 800))
    const refused = setup([b])
    refused.comp.place.mockResolvedValueOnce({ ok: false, error: 'placement_unconfirmed' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      refused.layout.arrange(refused.win(b.win), rect(10, 20, 400, 300)),
    ).resolves.toEqual({ ok: false, error: 'placement_unconfirmed' })
    expect(refused.saveBounds).not.toHaveBeenCalled()
  })

  it('persists only windows bound to a session and still open', () => {
    const a = spec(1, rect(0, 0, 289, 800))
    const stray = fakeWindow(7)
    const { layout, saveBounds, win } = setup([a])
    layout.persist(win(stray))
    a.win.destroy()
    layout.persist(win(a.win))
    expect(saveBounds).not.toHaveBeenCalled()
  })

  it('writes every session window with its name, display and state', () => {
    const a = spec(1, rect(0, 0, 289, 800))
    const b = spec(2, rect(735, 0, 289, 800), { minimized: true })
    const { layout, all, comp } = setup([a, b])
    all.push(fakeWindow(9)) // not a session window
    comp.rects.set(9, rect(0, 0, 10, 10))
    layout.scheduleWrite()
    vi.advanceTimersByTime(300)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.boundsReliable).toBe(true)
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
