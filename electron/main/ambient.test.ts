import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAmbient } from './ambient'
import { WindowRegistry } from './window-registry'

function fakeWindow(id: number, bounds = { x: id * 1000, y: 0, width: 800, height: 600 }) {
  const win = {
    id,
    visible: true,
    minimized: false,
    destroyed: false,
    bounds,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    getContentBounds: () => win.bounds,
    webContents: { send: vi.fn() },
  }
  return win
}
type FakeWindow = ReturnType<typeof fakeWindow>
type Handler = (event: unknown, ...args: unknown[]) => unknown

const KEYS = ['birds', 'joust', 'maze']

function setup(o: { windows?: FakeWindow[]; arcade?: string; urgent?: string[] } = {}) {
  const windows = o.windows ?? []
  const byId = (id: number) => windows.find((w) => w.id === id) ?? null
  const registry = new WindowRegistry({
    fromId: (id) => byId(id) as unknown as BrowserWindow | null,
    fromWebContents: (wc) =>
      (windows.find((w) => w.webContents === (wc as unknown)) ??
        null) as unknown as BrowserWindow | null,
    getAllWindows: () => windows as unknown as BrowserWindow[],
    getFocusedWindow: () => state.focused as unknown as BrowserWindow | null,
  })
  for (const w of windows) registry.bindSession(w.id, `s${w.id}`)
  const settings = new Map<string, string>()
  if (o.arcade) settings.set('arcade', o.arcade)
  const state = {
    focused: null as FakeWindow | null,
    quitting: false,
    urgent: o.urgent ?? [],
    cursor: { x: 0, y: 0 },
  }
  const screen = { getCursorScreenPoint: vi.fn(() => ({ ...state.cursor })) }
  const setSetting = vi.fn((key: string, value: string) => {
    settings.set(key, value)
  })
  const ambient = createAmbient({
    registry,
    screen: screen as never,
    getSetting: (key) => settings.get(key),
    setSetting,
    urgent: () => state.urgent,
    isQuitting: () => state.quitting,
    random: () => 0,
  })
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    on: (channel: string, fn: Handler) => handlers.set(channel, fn),
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  }
  ambient.registerIpc(ipcMain as never)
  const call = (channel: string, win: FakeWindow | null, ...args: unknown[]) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    const event = { sender: win?.webContents ?? {} } as unknown as IpcMainEvent & IpcMainInvokeEvent
    return fn(event, ...args)
  }
  return { ambient, handlers, call, screen, settings, setSetting, state, registry }
}

const looks = (w: FakeWindow) =>
  w.webContents.send.mock.calls.filter(([channel]) => channel === 'eyes:look').map(([, p]) => p)

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('IPC', () => {
  it('registers the seven eyes and arcade channels', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      'arcade:assign',
      'arcade:enabled',
      'arcade:next',
      'arcade:pick',
      'arcade:toggle',
      'arcade:turn-on',
      'eyes:anchor',
    ])
  })
})

describe('cursor pump', () => {
  it('runs every 100 ms while any window has a game', () => {
    const win = fakeWindow(1)
    const { call, screen } = setup({ windows: [win] })
    call('arcade:assign', win, KEYS)
    vi.advanceTimersByTime(300)
    expect(screen.getCursorScreenPoint).toHaveBeenCalledTimes(3)
  })

  it('runs every 250 ms with only unfocused windows', () => {
    const win = fakeWindow(1)
    const { ambient, screen, state } = setup({ windows: [win], arcade: 'off' })
    ambient.blurred(1)
    vi.advanceTimersByTime(249)
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(screen.getCursorScreenPoint).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('win:cursor', { x: 0, y: 0 })
    // An unmoved cursor is not resent.
    vi.advanceTimersByTime(250)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    state.cursor = { x: 5, y: 6 }
    vi.advanceTimersByTime(250)
    expect(win.webContents.send).toHaveBeenLastCalledWith('win:cursor', { x: 5, y: 6 })
  })

  it('stops when nothing needs it', () => {
    const win = fakeWindow(1)
    const { ambient, screen } = setup({ windows: [win] })
    vi.advanceTimersByTime(1000)
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled()
    ambient.blurred(1)
    ambient.focused(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a focus change forces one fresh send of an unmoved cursor', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const { ambient } = setup({ windows: [win1, win2] })
    ambient.blurred(1)
    vi.advanceTimersByTime(250)
    ambient.blurred(2)
    vi.advanceTimersByTime(250)
    expect(win1.webContents.send).toHaveBeenCalledTimes(2)
    expect(win2.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('tells a game window when the cursor is near its titlebar, and once when it leaves', () => {
    const win = fakeWindow(1, { x: 100, y: 100, width: 800, height: 600 })
    const { call, state } = setup({ windows: [win] })
    call('arcade:assign', win, KEYS)
    state.cursor = { x: 150, y: 110 }
    vi.advanceTimersByTime(100)
    expect(win.webContents.send).toHaveBeenLastCalledWith('arcade:cursor', { x: 50, y: 10 })
    state.cursor = { x: 1500, y: 1500 }
    vi.advanceTimersByTime(100)
    expect(win.webContents.send).toHaveBeenLastCalledWith('arcade:cursor', null)
    state.cursor = { x: 1600, y: 1600 }
    vi.advanceTimersByTime(100)
    expect(win.webContents.send).toHaveBeenCalledTimes(2)
  })

  it('a closed window frees its game and the pump stops', () => {
    const win = fakeWindow(1)
    const { ambient, call, screen } = setup({ windows: [win] })
    call('arcade:assign', win, KEYS)
    ambient.blurred(1)
    ambient.forget(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled()
  })
})

describe('arcade', () => {
  it('is on unless the setting says off', () => {
    expect(setup().call('arcade:enabled', null)).toBe(true)
    expect(setup({ arcade: 'off' }).call('arcade:enabled', null)).toBe(false)
  })

  it('a window keeps its game across reloads', () => {
    const win = fakeWindow(1)
    const { call } = setup({ windows: [win] })
    const first = call('arcade:assign', win, KEYS)
    expect(KEYS).toContain(first)
    for (let i = 0; i < 5; i++) expect(call('arcade:assign', win, KEYS)).toBe(first)
  })

  it('open windows do not repeat a game while one is free', () => {
    const wins = [fakeWindow(1), fakeWindow(2), fakeWindow(3)]
    const { call } = setup({ windows: wins })
    const games = wins.map((w) => call('arcade:assign', w, KEYS))
    expect(new Set(games).size).toBe(3)
  })

  it('refuses a bad game list, an unknown window, or games turned off', () => {
    const win = fakeWindow(1)
    expect(setup({ windows: [win] }).call('arcade:assign', win, ['Bad Key'])).toBeNull()
    expect(setup({ windows: [win] }).call('arcade:assign', null, KEYS)).toBeNull()
    expect(setup({ windows: [win], arcade: 'off' }).call('arcade:assign', win, KEYS)).toBeNull()
  })

  it('turning games off clears every game and stops the pump; every window is told', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const { call, setSetting, screen } = setup({ windows: [win1, win2] })
    call('arcade:pick', win1, 'joust', KEYS)
    call('arcade:toggle', null)
    expect(setSetting).toHaveBeenCalledWith('arcade', 'off')
    expect(win1.webContents.send).toHaveBeenCalledWith('arcade:enabled', false)
    expect(win2.webContents.send).toHaveBeenCalledWith('arcade:enabled', false)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled()
    // Back on: win2 may now get joust, since win1's game was cleared.
    call('arcade:toggle', null)
    expect(setSetting).toHaveBeenLastCalledWith('arcade', 'on')
    expect(win2.webContents.send).toHaveBeenLastCalledWith('arcade:enabled', true)
    // With both free, the first one is picked (it would be maze if joust were still held).
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(call('arcade:assign', win2, ['joust', 'maze'])).toBe('joust')
  })

  it('choosing a game while games are off turns them on for every window', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const { call, settings } = setup({ windows: [win1, win2], arcade: 'off' })
    expect(call('arcade:pick', win1, 'maze', KEYS)).toBe('maze')
    expect(settings.get('arcade')).toBe('on')
    expect(win1.webContents.send).toHaveBeenCalledWith('arcade:enabled', true)
    expect(win2.webContents.send).toHaveBeenCalledWith('arcade:enabled', true)
    expect(call('arcade:assign', win1, KEYS)).toBe('maze')
  })

  it('Next game while games are off turns them on once; a second press keeps them on', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const { call, settings, setSetting } = setup({ windows: [win1, win2], arcade: 'off' })
    // Two presses that both saw the games off (two windows, or one press racing a load).
    call('arcade:turn-on', win1)
    call('arcade:turn-on', win2)
    expect(settings.get('arcade')).toBe('on')
    expect(setSetting).toHaveBeenCalledTimes(1)
    expect(win1.webContents.send).toHaveBeenCalledWith('arcade:enabled', true)
    expect(win2.webContents.send).not.toHaveBeenCalledWith('arcade:enabled', false)
    expect(call('arcade:assign', win1, KEYS)).not.toBeNull()
  })

  it('choosing a game the window does not ship is refused', () => {
    const win = fakeWindow(1)
    const { call, setSetting } = setup({ windows: [win], arcade: 'off' })
    expect(call('arcade:pick', win, 'tetris', KEYS)).toBeNull()
    expect(call('arcade:pick', win, 7, KEYS)).toBeNull()
    expect(setSetting).not.toHaveBeenCalled()
  })

  it('next game skips games other windows are showing', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const { call } = setup({ windows: [win1, win2] })
    call('arcade:pick', win1, 'birds', KEYS)
    call('arcade:pick', win2, 'joust', KEYS)
    expect(call('arcade:next', win1, KEYS)).toBe('maze')
    expect(call('arcade:assign', win1, KEYS)).toBe('maze')
  })

  it('next game is refused while games are off', () => {
    const win = fakeWindow(1)
    expect(setup({ windows: [win], arcade: 'off' }).call('arcade:next', win, KEYS)).toBeNull()
  })

  it('a closed window frees its game for the next window', () => {
    const wins = [fakeWindow(1), fakeWindow(2), fakeWindow(3), fakeWindow(4)]
    const { ambient, call } = setup({ windows: wins })
    call('arcade:pick', wins[0], 'birds', KEYS)
    call('arcade:pick', wins[1], 'joust', KEYS)
    expect(call('arcade:assign', wins[2], KEYS)).toBe('maze')
    ambient.forget(1)
    expect(call('arcade:assign', wins[3], KEYS)).toBe('birds')
  })
})

describe('gaze scenes', () => {
  it('a scene reaches each visible window, with its eyes where it said', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const hidden = fakeWindow(3)
    hidden.minimized = true
    const { ambient, call } = setup({ windows: [win1, win2, hidden] })
    call('eyes:anchor', win2, { x: 10.4, y: 5.6 })
    ambient.start()

    vi.advanceTimersByTime(20_000) // SCENE_EVERY_MS low end, random() = 0

    expect(looks(win1)).toEqual([{ x: 2010, y: 6, delay: 0, hold: 1500 }])
    expect(looks(win2)).toEqual([{ x: 1036, y: 16, delay: 450, hold: 1050 }])
    expect(looks(hidden)).toEqual([])
    expect(log).toHaveBeenCalledWith('[aico:gaze] scene s1 s2')
  })

  it('ignores an eye anchor that is out of range or not a number', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const { ambient, call } = setup({ windows: [win1, win2] })
    call('eyes:anchor', win2, { x: 4001, y: 5 })
    call('eyes:anchor', win2, { x: Number.NaN, y: 5 })
    call('eyes:anchor', win2, { x: 5, y: Number.POSITIVE_INFINITY })
    call('eyes:anchor', win2, { x: '5', y: 5 })
    call('eyes:anchor', win2, null)
    ambient.start()
    vi.advanceTimersByTime(20_000)
    expect(looks(win1)).toEqual([{ x: 2036, y: 16, delay: 0, hold: 1500 }])
  })

  it('nothing is sent with fewer than two visible windows', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    win2.visible = false
    const { ambient } = setup({ windows: [win1, win2] })
    ambient.start()
    vi.advanceTimersByTime(60_000)
    expect(looks(win1)).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps playing scenes and logs only the first three', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const { ambient } = setup({ windows: [win1, win2] })
    ambient.start()
    vi.advanceTimersByTime(20_000 * 5)
    expect(looks(win1)).toHaveLength(5)
    expect(log).toHaveBeenCalledTimes(3)
  })

  it('stop clears the scene timer; quitting skips a scene already due', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const first = setup({ windows: [win1, win2] })
    first.ambient.start()
    first.ambient.stop()
    vi.advanceTimersByTime(60_000)
    expect(looks(win1)).toEqual([])

    const second = setup({ windows: [win1, win2] })
    second.ambient.start()
    second.state.quitting = true
    vi.advanceTimersByTime(60_000)
    expect(looks(win1)).toEqual([])
  })
})

describe('urgent looks', () => {
  it('every 20 s the other windows look at a window waiting too long; it keeps its own look', () => {
    const wins = [fakeWindow(1), fakeWindow(2), fakeWindow(3)]
    const { ambient } = setup({ windows: wins, urgent: ['s1'] })
    ambient.startUrgentLooks()
    vi.advanceTimersByTime(19_999)
    expect(looks(wins[1])).toEqual([])
    vi.advanceTimersByTime(1)
    expect(looks(wins[0])).toEqual([])
    expect(looks(wins[1])).toEqual([{ x: 1036, y: 16, delay: 0, hold: 1700 }])
    expect(looks(wins[2])).toEqual([{ x: 1036, y: 16, delay: 140, hold: 1700 }])
  })

  it('skips an urgent session whose window is not visible', () => {
    const wins = [fakeWindow(1), fakeWindow(2)]
    wins[0].visible = false
    const { ambient } = setup({ windows: wins, urgent: ['s1', 'gone'] })
    ambient.startUrgentLooks()
    vi.advanceTimersByTime(20_000)
    expect(looks(wins[1])).toEqual([])
  })
})
