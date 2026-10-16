// The generic renderer channels that need only Electron and the settings
// store: the clipboard, opening links, the window buttons and drag-resize, and
// the shared pinned actions and terminal font, broadcast to every window.

import type { Clipboard, IpcMain, Shell } from 'electron'
import { parseTerminalFontSettings } from '../shared/font-settings'
import { parseBoundsRequest, parsePins } from './ipc-validation'
import type { WindowRegistry } from './window-registry'

interface DesktopIpcDeps {
  clipboard: Pick<Clipboard, 'readText' | 'readImage' | 'writeText'>
  shell: Pick<Shell, 'openExternal'>
  registry: Pick<WindowRegistry, 'senderWindow' | 'all'>
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
}

export function registerDesktopIpc(
  ipcMain: Pick<IpcMain, 'on' | 'handle'>,
  deps: DesktopIpcDeps,
): void {
  const { clipboard, shell, getSetting, setSetting } = deps

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:has-image', () => !clipboard.readImage().isEmpty())
  ipcMain.on('link:open', (_event, url: unknown) => {
    if (typeof url !== 'string' || url.length > 8192) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        void shell.openExternal(parsed.toString())
    } catch {
      // Not a URL: ignore.
    }
  })
  ipcMain.on('clipboard:write', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  ipcMain.on('win:minimize', (event) => deps.registry.senderWindow(event.sender)?.minimize())
  ipcMain.on('win:toggle-maximize', (event) => {
    const win = deps.registry.senderWindow(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })
  ipcMain.on('win:close', (event) => deps.registry.senderWindow(event.sender)?.close())
  ipcMain.on('win:set-bounds', (event, b: unknown) => {
    const bounds = parseBoundsRequest(b)
    if (bounds) deps.registry.senderWindow(event.sender)?.setBounds(bounds)
  })

  // Global pinned-action set (one row in aico.db, shared across widgets). A
  // setPins from any widget persists and broadcasts so every cluster updates.
  ipcMain.handle('settings:get-pins', () => {
    const raw = getSetting('pins')
    if (raw == null) return null
    try {
      return parsePins(JSON.parse(raw))
    } catch {
      return null
    }
  })
  ipcMain.on('settings:set-pins', (_event, input: unknown) => {
    const ids = parsePins(input)
    if (!ids) return
    setSetting('pins', JSON.stringify(ids))
    for (const win of deps.registry.all()) {
      win.webContents.send('settings:pins-changed', ids)
    }
  })

  ipcMain.handle('settings:get-terminal-font', () => {
    const raw = getSetting('terminal-font')
    if (raw == null) return null
    try {
      return parseTerminalFontSettings(JSON.parse(raw))
    } catch {
      return null
    }
  })
  ipcMain.on('settings:set-terminal-font', (_event, payload: unknown) => {
    const settings = parseTerminalFontSettings(payload)
    setSetting('terminal-font', JSON.stringify(settings))
    for (const win of deps.registry.all()) {
      win.webContents.send('settings:terminal-font-changed', settings)
    }
  })
}
