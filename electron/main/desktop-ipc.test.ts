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
import { dirname, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { controlSocketPath, RemoteUploadError } from 'tether/term'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ImagePaste, registerDesktopIpc } from './desktop-ipc'

function fakeWindow(id: number) {
  return {
    id,
    maximized: false,
    minimize: vi.fn(),
    isMaximized() {
      return this.maximized
    },
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    webContents: { send: vi.fn() },
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(
  stored: Record<string, string> = {},
  remote: { host: string | null; sendToHost?: unknown; hosts?: unknown[] } = { host: null },
) {
  const win1 = fakeWindow(1)
  const win2 = fakeWindow(2)
  const all = [win1, win2]
  const settings = new Map(Object.entries(stored))
  const setSetting = vi.fn((key: string, value: string) => {
    settings.set(key, value)
  })
  const root = mkdtempSync(join(tmpdir(), 'aico-desktop-ipc-'))
  roots.push(root)
  const pastedImages = {
    dir: join(root, 'pasted-images'),
    maxAgeMs: 86_400_000,
    remoteDir: '~/.cache/aico/uploads',
  }
  const clipboard = {
    readText: vi.fn(() => 'copied'),
    readImage: vi.fn((): { isEmpty(): boolean; toPNG(): Buffer } => ({
      isEmpty: () => false,
      toPNG: () => PNG,
    })),
    writeText: vi.fn(),
  }
  const shell = { openExternal: vi.fn(async () => {}) }
  const on = new Map<string, (...args: unknown[]) => unknown>()
  const handle = new Map<string, (...args: unknown[]) => unknown>()
  registerDesktopIpc(
    {
      on: ((channel: string, fn: (...args: unknown[]) => unknown) => {
        on.set(channel, fn)
      }) as never,
      handle: ((channel: string, fn: (...args: unknown[]) => unknown) => {
        handle.set(channel, fn)
      }) as never,
    },
    {
      clipboard: clipboard as never,
      pastedImages,
      sessionHost: () => remote.host,
      hosts: async () => (remote.hosts ?? []) as never,
      sendToHost: remote.sendToHost as never,
      shell,
      compositor: { isMaximized: (win) => (win as unknown as { maximized: boolean }).maximized },
      registry: {
        senderWindow: (wc) =>
          (all.find((w) => w.webContents === (wc as unknown)) ??
            null) as unknown as BrowserWindow | null,
        all: () => all as unknown as BrowserWindow[],
      },
      getSetting: (key) => settings.get(key),
      setSetting,
    },
  )
  const event = { sender: win1.webContents }
  return { win1, win2, settings, pastedImages, setSetting, clipboard, shell, on, handle, event }
}

/** The `clipboard:image-path` answer, through the registered handler. */
const imagePaste = (handle: Map<string, (...args: unknown[]) => unknown>, event: unknown) =>
  handle.get('clipboard:image-path')?.(event) as Promise<ImagePaste>

describe('desktop IPC', () => {
  it('registers its eleven channels', () => {
    const { on, handle } = setup()
    expect([...handle.keys()].sort()).toEqual([
      'clipboard:image-path',
      'clipboard:read',
      'settings:get-pins',
      'settings:get-terminal-font',
    ])
    expect([...on.keys()].sort()).toEqual([
      'clipboard:write',
      'link:open',
      'settings:set-pins',
      'settings:set-terminal-font',
      'win:close',
      'win:minimize',
      'win:toggle-maximize',
    ])
  })

  it('reads and writes the clipboard, writing only text', () => {
    const { on, handle, clipboard } = setup()
    expect(handle.get('clipboard:read')?.()).toBe('copied')
    on.get('clipboard:write')?.({}, 42)
    expect(clipboard.writeText).not.toHaveBeenCalled()
    on.get('clipboard:write')?.({}, 'hello')
    expect(clipboard.writeText).toHaveBeenCalledWith('hello')
  })

  it('saves a clipboard image as a PNG file and returns its path', async () => {
    const { handle, pastedImages, event } = setup()
    const { path, error } = (await imagePaste(handle, event)) as ImagePaste
    expect(error).toBeUndefined()
    expect(path.startsWith(`${pastedImages.dir}/paste-`)).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
    expect(readFileSync(path)).toEqual(PNG)
    expect(statSync(path).mode & 0o777).toBe(0o644)
    expect(statSync(pastedImages.dir).mode & 0o777).toBe(0o755)
    expect(await handle.get('clipboard:image-path')?.(event)).not.toEqual({ path })
  })

  it('returns no path when the clipboard has no image, leaving text paste alone', async () => {
    const { handle, clipboard, pastedImages, event } = setup()
    clipboard.readImage.mockReturnValue({ isEmpty: () => true, toPNG: () => PNG })
    expect(await handle.get('clipboard:image-path')?.(event)).toEqual({ path: '' })
    expect(existsSync(pastedImages.dir)).toBe(false)
    expect(handle.get('clipboard:read')?.()).toBe('copied')
  })

  it('returns no path, and says why, when the image cannot be saved', async () => {
    const { handle, pastedImages, event } = setup()
    // A folder that can't exist: its parent is a file.
    mkdirSync(dirname(pastedImages.dir), { recursive: true })
    writeFileSync(join(dirname(pastedImages.dir), 'file'), '')
    pastedImages.dir = join(dirname(pastedImages.dir), 'file', 'pasted-images')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await handle.get('clipboard:image-path')?.(event)).toEqual({
      path: '',
      error: 'Couldn’t save the pasted image.',
    })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  describe('in a window whose session runs on another host', () => {
    const row = {
      name: 'agent-work',
      state: 'connected',
      ssh: 'agent-work-vm',
      control: controlSocketPath('agent-work'),
    }

    it('sends the image there, returns the host path, and keeps no copy here', async () => {
      const sendToHost = vi.fn(
        async (_remote, _png, name: string, _options: unknown) => `/home/agent/up/${name}`,
      )
      const { handle, pastedImages, event } = setup(
        {},
        { host: 'agent-work', sendToHost, hosts: [row] },
      )
      const { path, error } = (await imagePaste(handle, event)) as ImagePaste
      expect(error).toBeUndefined()
      expect(path).toMatch(/^\/home\/agent\/up\/paste-\d+-[0-9a-f]{12}\.png$/)
      const [remote, png, , options] = sendToHost.mock.calls[0]
      expect(remote).toMatchObject({ host: 'agent-work', alias: 'agent-work-vm' })
      expect(Buffer.from(png)).toEqual(PNG)
      expect(options).toEqual({ dir: '~/.cache/aico/uploads', maxAgeMs: 86_400_000 })
      expect(existsSync(pastedImages.dir)).toBe(false)
    })

    it('returns no path, saves nothing here, and says why, when the host is offline or the send fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const paste = async (hosts: unknown[], sendToHost: unknown) => {
        const s = setup({}, { host: 'agent-work', sendToHost, hosts })
        const answer = await s.handle.get('clipboard:image-path')?.(s.event)
        expect(existsSync(s.pastedImages.dir)).toBe(false)
        return answer
      }
      const unused = vi.fn()
      expect(await paste([{ ...row, state: 'offline' }], unused)).toEqual({
        path: '',
        error: 'agent-work is offline, so the image wasn’t sent.',
      })
      expect(await paste([], unused)).toEqual({
        path: '',
        error: 'agent-work isn’t linked, so the image wasn’t sent.',
      })
      expect(await paste([{ ...row, control: '/tmp/elsewhere.sock' }], unused)).toEqual({
        path: '',
        error: 'agent-work’s link looks wrong, so the image wasn’t sent.',
      })
      expect(unused).not.toHaveBeenCalled()
      const dropped = vi.fn(async () => {
        throw new RemoteUploadError('offline', 'agent-work', 'exit 255')
      })
      expect(await paste([row], dropped)).toEqual({
        path: '',
        error: 'agent-work is offline, so the image wasn’t sent.',
      })
      const refused = vi.fn(async () => {
        throw new RemoteUploadError('failed', 'agent-work', 'No space left on device')
      })
      expect(await paste([row], refused)).toEqual({
        path: '',
        error: 'agent-work didn’t accept the image, so it wasn’t sent.',
      })
      expect(error).toHaveBeenCalledTimes(5)
      error.mockRestore()
    })
  })

  it('opens only http(s) links of at most 8192 characters', () => {
    const { on, shell } = setup()
    const open = on.get('link:open')
    open?.({}, 'https://example.com/a')
    open?.({}, 'http://example.com/b')
    open?.({}, 'file:///etc/passwd')
    open?.({}, 'javascript:alert(1)')
    open?.({}, 'not a url')
    open?.({}, 7)
    open?.({}, `https://example.com/${'x'.repeat(8192)}`)
    expect(shell.openExternal.mock.calls).toEqual([
      ['https://example.com/a'],
      ['http://example.com/b'],
    ])
  })

  it('drives the sending window: minimize, maximize toggle and close', () => {
    const { on, win1, win2, event } = setup()
    on.get('win:minimize')?.(event)
    expect(win1.minimize).toHaveBeenCalledTimes(1)
    on.get('win:toggle-maximize')?.(event)
    expect(win1.maximize).toHaveBeenCalledTimes(1)
    win1.maximized = true
    on.get('win:toggle-maximize')?.(event)
    expect(win1.unmaximize).toHaveBeenCalledTimes(1)
    on.get('win:close')?.(event)
    expect(win1.close).toHaveBeenCalledTimes(1)
    expect(win2.minimize).not.toHaveBeenCalled()
    // A sender with no window is ignored.
    expect(() => on.get('win:close')?.({ sender: {} })).not.toThrow()
  })

  it('stores valid pins and broadcasts them to every window', () => {
    const { on, win1, win2, setSetting } = setup()
    on.get('settings:set-pins')?.({}, ['open', 'end'])
    expect(setSetting).toHaveBeenCalledWith('pins', '["open","end"]')
    expect(win1.webContents.send).toHaveBeenCalledWith('settings:pins-changed', ['open', 'end'])
    expect(win2.webContents.send).toHaveBeenCalledWith('settings:pins-changed', ['open', 'end'])
  })

  it('writes and broadcasts nothing for invalid pins', () => {
    const { on, win1, setSetting } = setup()
    on.get('settings:set-pins')?.({}, 'open')
    on.get('settings:set-pins')?.({}, [''])
    on.get('settings:set-pins')?.({}, [1])
    expect(setSetting).not.toHaveBeenCalled()
    expect(win1.webContents.send).not.toHaveBeenCalled()
  })

  it('reads pins back, as null when missing, bad JSON or invalid', () => {
    expect(setup().handle.get('settings:get-pins')?.()).toBeNull()
    expect(setup({ pins: '{bad' }).handle.get('settings:get-pins')?.()).toBeNull()
    expect(setup({ pins: '[1]' }).handle.get('settings:get-pins')?.()).toBeNull()
    expect(setup({ pins: '["open"]' }).handle.get('settings:get-pins')?.()).toEqual(['open'])
  })

  it('parses, stores and broadcasts the terminal font, falling back to defaults', () => {
    const { on, handle, win1, win2, setSetting } = setup()
    on.get('settings:set-terminal-font')?.({}, { fontId: 'fira-code', fontSize: 15 })
    const fira = { fontId: 'fira-code', fontSize: 15 }
    expect(setSetting).toHaveBeenCalledWith('terminal-font', JSON.stringify(fira))
    expect(win1.webContents.send).toHaveBeenCalledWith('settings:terminal-font-changed', fira)
    expect(win2.webContents.send).toHaveBeenCalledWith('settings:terminal-font-changed', fira)
    expect(handle.get('settings:get-terminal-font')?.()).toEqual(fira)
    on.get('settings:set-terminal-font')?.({}, { fontId: 'comic-sans', fontSize: 99 })
    expect(handle.get('settings:get-terminal-font')?.()).toEqual({
      fontId: 'iosevka',
      fontSize: 13,
    })
  })

  it('reads the terminal font back as null when missing or bad JSON', () => {
    expect(setup().handle.get('settings:get-terminal-font')?.()).toBeNull()
    expect(
      setup({ 'terminal-font': 'nope' }).handle.get('settings:get-terminal-font')?.(),
    ).toBeNull()
  })
})
