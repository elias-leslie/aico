// The generic renderer channels that need only Electron and the settings
// store: the clipboard, opening links, the window buttons, and
// the shared pinned actions and terminal font, broadcast to every window.

import { randomBytes } from 'node:crypto'
import type { Clipboard, IpcMain, Shell } from 'electron'
import type { HostInfo } from 'tether/client'
import { type RemoteHost, RemoteUploadError, remoteHostOf, uploadToHost } from 'tether/term'
import { parseTerminalFontSettings } from '../../shared/font-settings'
import type { Compositor } from './compositor'
import { parsePins } from './ipc-validation'
import { type PastedImageStore, savePastedImage } from './pasted-image'
import type { WindowRegistry } from './window-registry'

/** `clipboard:image-path`'s answer: the path to type, or why there is none. */
export interface ImagePaste {
  path: string
  error?: string
}

interface DesktopIpcDeps {
  clipboard: Pick<Clipboard, 'readText' | 'readImage' | 'writeText'>
  pastedImages: PastedImageStore & { remoteDir: string }
  /** The host a window's session runs on; null for this computer. */
  sessionHost(sender: Electron.WebContents): string | null
  hosts(): Promise<HostInfo[]>
  /** Tests pass a fake for the ssh send. */
  sendToHost?: typeof uploadToHost
  shell: Pick<Shell, 'openExternal'>
  registry: Pick<WindowRegistry, 'senderWindow' | 'all'>
  compositor: Pick<Compositor, 'isMaximized'>
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
}

/** Why a pasted image wasn't sent to `host`, worded as the web app's upload refusals. */
class NotSent extends Error {}

/** The link to `host`, or the plain-words reason it can't carry a file. */
async function linkTo(host: string, hosts: () => Promise<HostInfo[]>): Promise<RemoteHost> {
  const row = (await hosts()).find((item) => item.name === host)
  if (!row) throw new NotSent(`${host} isn’t linked, so the image wasn’t sent.`)
  if (row.state !== 'connected') throw new NotSent(offline(host))
  try {
    return remoteHostOf({
      host,
      ssh: { alias: row.ssh, control: row.control, stateDir: row.stateDir },
    }) as RemoteHost
  } catch {
    throw new NotSent(`${host}’s link looks wrong, so the image wasn’t sent.`)
  }
}

const offline = (host: string) => `${host} is offline, so the image wasn’t sent.`

/** What the owner is told when a pasted image didn't get through. */
function pasteFailure(host: string | null, error: unknown): string {
  if (!host) return 'Couldn’t save the pasted image.'
  if (error instanceof NotSent) return error.message
  if (error instanceof RemoteUploadError && error.kind === 'offline') return offline(host)
  return `${host} didn’t accept the image, so it wasn’t sent.`
}

export function registerDesktopIpc(
  ipcMain: Pick<IpcMain, 'on' | 'handle'>,
  deps: DesktopIpcDeps,
): void {
  const { clipboard, shell, pastedImages, getSetting, setSetting } = deps

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  // The clipboard image as a file path the terminal program can read: '' when
  // there is no image, and the reason in plain words when it couldn't be
  // saved or sent. For a session on another host the file is sent there and
  // the path is the host's: this computer's copy would be a path that host
  // can't read, and is not kept.
  ipcMain.handle('clipboard:image-path', async (event): Promise<ImagePaste> => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return { path: '' }
    const host = deps.sessionHost(event.sender)
    try {
      if (host) {
        const remote = await linkTo(host, deps.hosts)
        const name = `paste-${Date.now()}-${randomBytes(6).toString('hex')}.png`
        const path = await (deps.sendToHost ?? uploadToHost)(remote, image.toPNG(), name, {
          dir: pastedImages.remoteDir,
          maxAgeMs: pastedImages.maxAgeMs,
        })
        return { path }
      }
      return { path: savePastedImage(pastedImages, image.toPNG()) }
    } catch (error) {
      console.error(
        host ? `Could not send the pasted image to ${host}:` : 'Could not save the pasted image:',
        error,
      )
      return { path: '', error: pasteFailure(host, error) }
    }
  })
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
    if (deps.compositor.isMaximized(win)) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })
  ipcMain.on('win:close', (event) => deps.registry.senderWindow(event.sender)?.close())

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
