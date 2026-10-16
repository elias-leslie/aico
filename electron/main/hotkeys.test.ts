import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHotkeys } from './hotkeys'
import { WindowRegistry } from './window-registry'

const PAGE = 'file:///opt/aico/out/renderer/index.html'

function fakeWindow(id: number) {
  return {
    id,
    isDestroyed: () => false,
    webContents: { send: vi.fn(), getURL: () => PAGE },
  }
}
type FakeWindow = ReturnType<typeof fakeWindow>

type RequestHandler = (
  webContents: unknown,
  permission: string,
  cb: (granted: boolean) => void,
  details: Record<string, unknown>,
) => void
type CheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: Record<string, unknown>,
) => boolean

function setup(o: { rendererUrl?: string; ready?: boolean; registered?: boolean } = {}) {
  const sessionWin = fakeWindow(1)
  const otherWin = fakeWindow(2)
  const all: FakeWindow[] = [sessionWin, otherWin]
  const registry = new WindowRegistry({
    fromId: (id) => (all.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
    fromWebContents: () => null,
    getAllWindows: () => all as unknown as BrowserWindow[],
  })
  registry.bindSession(1, 'aaaaaaaa')
  const shortcuts = new Map<string, () => void>()
  const globalShortcut = {
    register: vi.fn((accelerator: string, fn: () => void) => {
      shortcuts.set(accelerator, fn)
      return o.registered ?? true
    }),
    unregisterAll: vi.fn(),
  }
  const handlers: { request?: RequestHandler; check?: CheckHandler; headers?: unknown } = {}
  const defaultSession = {
    webRequest: {
      onHeadersReceived: vi.fn((fn: unknown) => {
        handlers.headers = fn
      }),
    },
    setPermissionRequestHandler: vi.fn((fn: RequestHandler) => {
      handlers.request = fn
    }),
    setPermissionCheckHandler: vi.fn((fn: CheckHandler) => {
      handlers.check = fn
    }),
  }
  const session = vi.fn(() => defaultSession)
  const state = { focused: null as FakeWindow | null, target: undefined as string | undefined }
  const grab = vi.fn(async () => {})
  const hotkeys = createHotkeys({
    registry,
    grab,
    target: () => state.target,
    config: {
      selectionHotkey: 'Ctrl+Shift+Space',
      voicePttHotkey: 'Ctrl+Shift+M',
      voiceWsUrl: 'ws://127.0.0.1:8003/api/voice/ws?user_id=aico&app=aico',
      rendererUrl: o.rendererUrl,
    },
    globalShortcut,
    session: session as never,
    app: { isReady: () => o.ready ?? true },
    fromWebContents: (wc) =>
      (all.find((w) => w.webContents === (wc as unknown)) ??
        null) as unknown as BrowserWindow | null,
    focusedWindow: () => state.focused as unknown as BrowserWindow | null,
  })
  const handle = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: ((channel: string, fn: (...args: unknown[]) => unknown) => {
      handle.set(channel, fn)
    }) as never,
  }
  return {
    hotkeys,
    sessionWin,
    otherWin,
    globalShortcut,
    shortcuts,
    handlers,
    session,
    defaultSession,
    state,
    grab,
    handle,
    ipcMain,
  }
}

const audio = { requestingUrl: PAGE, isMainFrame: true, mediaTypes: ['audio'] }

afterEach(() => vi.restoreAllMocks())

describe('hotkeys', () => {
  it('constructs without touching Electron', () => {
    const { session, globalShortcut } = setup()
    expect(session).not.toHaveBeenCalled()
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it('the indicate hotkey runs the selection grab and logs whether it took', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { hotkeys, shortcuts, grab } = setup()
    hotkeys.registerSelection()
    expect(log).toHaveBeenCalledWith('[aico] selection hotkey Ctrl+Shift+Space: registered')
    shortcuts.get('Ctrl+Shift+Space')?.()
    expect(grab).toHaveBeenCalledTimes(1)

    setup({ registered: false }).hotkeys.registerSelection()
    expect(log).toHaveBeenLastCalledWith(
      '[aico] selection hotkey Ctrl+Shift+Space: unavailable (Wayland? bind a GNOME shortcut to the grab path)',
    )
  })

  it('registers the voice URL, both permission handlers and the voice hotkey', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { hotkeys, handle, handlers, ipcMain } = setup()
    hotkeys.registerVoice(ipcMain)
    expect(handle.get('voice:ws-url')?.()).toBe(
      'ws://127.0.0.1:8003/api/voice/ws?user_id=aico&app=aico',
    )
    expect(handlers.request).toBeDefined()
    expect(handlers.check).toBeDefined()
    expect(log).toHaveBeenCalledWith('[aico] voice PTT hotkey Ctrl+Shift+M: registered')
  })

  it('grants audio only to a window that shows a session', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { hotkeys, handlers, sessionWin, otherWin, ipcMain } = setup()
    hotkeys.registerVoice(ipcMain)
    const answers: boolean[] = []
    handlers.request?.(sessionWin.webContents, 'media', (ok) => answers.push(ok), audio)
    handlers.request?.(otherWin.webContents, 'media', (ok) => answers.push(ok), audio)
    handlers.request?.({ getURL: () => PAGE }, 'media', (ok) => answers.push(ok), audio)
    handlers.request?.(sessionWin.webContents, 'media', (ok) => answers.push(ok), {
      ...audio,
      mediaTypes: ['video'],
    })
    expect(answers).toEqual([true, false, false, false])

    const check = { requestingUrl: PAGE, isMainFrame: true, mediaType: 'audio' }
    expect(handlers.check?.(sessionWin.webContents, 'media', PAGE, check)).toBe(true)
    expect(handlers.check?.(otherWin.webContents, 'media', PAGE, check)).toBe(false)
    expect(handlers.check?.(null, 'media', PAGE, check)).toBe(false)
  })

  it('the voice toggle goes to the focused session window, else the selection target', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { hotkeys, shortcuts, sessionWin, otherWin, state, ipcMain } = setup()
    hotkeys.registerVoice(ipcMain)
    const toggle = () => shortcuts.get('Ctrl+Shift+M')?.()

    state.focused = sessionWin
    toggle()
    expect(sessionWin.webContents.send).toHaveBeenCalledWith('voice:toggle')

    sessionWin.webContents.send.mockClear()
    state.focused = otherWin
    state.target = 'aaaaaaaa'
    toggle()
    expect(otherWin.webContents.send).not.toHaveBeenCalled()
    expect(sessionWin.webContents.send).toHaveBeenCalledWith('voice:toggle')

    sessionWin.webContents.send.mockClear()
    state.focused = null
    state.target = undefined
    toggle()
    expect(sessionWin.webContents.send).not.toHaveBeenCalled()
    expect(otherWin.webContents.send).not.toHaveBeenCalled()
  })

  it('sets the response-header CSP with the voice connect-src, but not under the dev server', () => {
    const { hotkeys, handlers } = setup()
    hotkeys.installCsp()
    const cb = vi.fn()
    ;(handlers.headers as (d: unknown, cb: unknown) => void)(
      { responseHeaders: { 'X-Other': ['1'] } },
      cb,
    )
    const headers = cb.mock.calls[0][0].responseHeaders
    expect(headers['X-Other']).toEqual(['1'])
    expect(headers['Content-Security-Policy'][0]).toContain(
      "connect-src 'self' ws://127.0.0.1:8003",
    )

    const dev = setup({ rendererUrl: 'http://localhost:5173' })
    dev.hotkeys.installCsp()
    expect(dev.session).not.toHaveBeenCalled()
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
