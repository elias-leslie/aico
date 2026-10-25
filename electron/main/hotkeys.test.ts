import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHotkeys } from './hotkeys'

function setup(o: { ready?: boolean; registered?: boolean; backend?: 'wayland' | 'x11' } = {}) {
  const shortcuts = new Map<string, () => void>()
  const globalShortcut = {
    register: vi.fn((accelerator: string, fn: () => void) => {
      shortcuts.set(accelerator, fn)
      return o.registered ?? true
    }),
    unregisterAll: vi.fn(),
  }
  const grab = vi.fn(async () => {})
  const hotkeys = createHotkeys({
    grab,
    config: { selectionHotkey: 'Ctrl+Shift+Space', displayBackend: o.backend ?? 'x11' },
    globalShortcut,
    app: { isReady: () => o.ready ?? true },
  })
  return { hotkeys, globalShortcut, shortcuts, grab }
}

afterEach(() => vi.restoreAllMocks())

describe('hotkeys', () => {
  it('constructs without touching Electron', () => {
    const { globalShortcut } = setup()
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it('the indicate hotkey runs the selection grab and logs whether it took', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { hotkeys, shortcuts, grab, globalShortcut } = setup()
    hotkeys.registerSelection()
    expect(log).toHaveBeenCalledWith('[aico] selection hotkey Ctrl+Shift+Space: registered')
    expect([...shortcuts.keys()]).toEqual(['Ctrl+Shift+Space'])
    expect(globalShortcut.register).toHaveBeenCalledTimes(1)
    shortcuts.get('Ctrl+Shift+Space')?.()
    expect(grab).toHaveBeenCalledTimes(1)

    setup({ registered: false }).hotkeys.registerSelection()
    expect(log).toHaveBeenLastCalledWith(
      '[aico] selection hotkey Ctrl+Shift+Space: unavailable (another app holds it)',
    )
  })

  it('tells windows the indicate hotkey only once it took', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const handlers = new Map<string, () => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, fn: () => unknown) => handlers.set(channel, fn)),
    }
    const ok = setup()
    ok.hotkeys.registerIpc(ipcMain as never)
    expect(handlers.get('hotkeys:selection')?.()).toBeNull()
    ok.hotkeys.registerSelection()
    expect(handlers.get('hotkeys:selection')?.()).toBe('Ctrl+Shift+Space')

    const taken = setup({ registered: false })
    taken.hotkeys.registerIpc(ipcMain as never)
    taken.hotkeys.registerSelection()
    expect(handlers.get('hotkeys:selection')?.()).toBeNull()
  })

  it('on Wayland registers no global shortcut: the GNOME custom shortcut calls indicate()', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { hotkeys, globalShortcut, grab } = setup({ backend: 'wayland' })
    const handlers = new Map<string, () => unknown>()
    hotkeys.registerIpc({ handle: (c: string, fn: () => unknown) => handlers.set(c, fn) } as never)
    hotkeys.registerSelection()
    expect(globalShortcut.register).not.toHaveBeenCalled()
    expect(handlers.get('hotkeys:selection')?.()).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('GNOME custom shortcut'))
    hotkeys.indicate()
    expect(grab).toHaveBeenCalledTimes(1)
  })

  it('stop() unregisters the shortcuts only once the app is ready', () => {
    const early = setup({ ready: false })
    early.hotkeys.stop()
    expect(early.globalShortcut.unregisterAll).not.toHaveBeenCalled()
    const ready = setup()
    ready.hotkeys.stop()
    expect(ready.globalShortcut.unregisterAll).toHaveBeenCalledTimes(1)
  })
})
