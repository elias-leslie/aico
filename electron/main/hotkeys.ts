// Global shortcuts and the voice plumbing they drive: the indicate (selection)
// hotkey, the push-to-talk hotkey with its websocket URL and microphone
// permission, and the response-header CSP that exists for the voice connect-src.

import type { App, GlobalShortcut, IpcMain, Session } from 'electron'
import type { AicoConfig } from './config'
import { contentSecurityPolicy, voiceConnectSource } from './csp'
import { allowTrustedAudioMedia } from './media-permission'
import type { WindowRegistry } from './window-registry'

interface HotkeysDeps {
  registry: Pick<WindowRegistry, 'hasSession' | 'forSession' | 'senderWindow' | 'focused'>
  /** The selection bus's indicate harvest. */
  grab(): Promise<void>
  /** The selection bus's target session. */
  target(): string | undefined
  config: Pick<AicoConfig, 'selectionHotkey' | 'voicePttHotkey' | 'voiceWsUrl' | 'rendererUrl'>
  globalShortcut: Pick<GlobalShortcut, 'register' | 'unregisterAll'>
  /** session.defaultSession, read only after ready. */
  session(): Pick<
    Session,
    'webRequest' | 'setPermissionRequestHandler' | 'setPermissionCheckHandler'
  >
  app: Pick<App, 'isReady'>
}

export function createHotkeys(deps: HotkeysDeps) {
  const { registry, config, globalShortcut } = deps

  // Push-to-talk: route the toggle to the widget the user is talking to — the
  // focused Aico window, falling back to the same target the selection bus uses
  // (last-focused open widget). That renderer owns the mic capture + insert.
  function toggleVoice(): void {
    const focused = registry.focused()
    const win =
      focused && registry.hasSession(focused.id)
        ? focused
        : registry.forSession(deps.target() ?? '')
    win?.webContents.send('voice:toggle')
  }

  // Lock the renderer to a strict CSP in production (the packaged file:// app).
  // Dev (ELECTRON_RENDERER_URL) is skipped: Vite's HMR needs inline/eval and its
  // own websocket. connect-src is opened only to the voice WS; everything else is
  // 'self'. Defense-in-depth so a renderer XSS can't reach arbitrary origins.
  function installContentSecurityPolicy(): void {
    if (config.rendererUrl) return // dev server: leave Vite's needs alone
    const voice = voiceConnectSource(config.voiceWsUrl)
    const csp = contentSecurityPolicy(voice ? [voice] : [])
    deps.session().webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      })
    })
  }

  return {
    installCsp: installContentSecurityPolicy,
    registerSelection: (): void => {
      // System-wide indicate hotkey (X11). Logs whether the grab actually took, so
      // a silent Wayland no-op is visible in the launcher log.
      const hotkeyOk = globalShortcut.register(config.selectionHotkey, () => void deps.grab())
      console.log(
        `[aico] selection hotkey ${config.selectionHotkey}: ${
          hotkeyOk ? 'registered' : 'unavailable (Wayland? bind a GNOME shortcut to the grab path)'
        }`,
      )
    },
    registerVoice: (ipcMain: Pick<IpcMain, 'handle'>): void => {
      // Push-to-talk hotkey (X11). Same Wayland caveat as the selection hotkey.
      ipcMain.handle('voice:ws-url', () => config.voiceWsUrl)
      // getUserMedia is denied by default. Bind the grant to a currently catalogued
      // Aico widget's main renderer document and to audio-only requests; another
      // webContents, iframe, navigated document, or video request is rejected.
      const session = deps.session()
      session.setPermissionRequestHandler((webContents, permission, cb, details) => {
        const win = registry.senderWindow(webContents)
        const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
        cb(
          allowTrustedAudioMedia({
            permission,
            trustedRenderer: win !== null && registry.hasSession(win.id),
            currentUrl: webContents.getURL(),
            requestingUrl: details.requestingUrl,
            isMainFrame: details.isMainFrame,
            mediaTypes,
          }),
        )
      })
      session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        const win = webContents ? registry.senderWindow(webContents) : null
        return allowTrustedAudioMedia({
          permission,
          trustedRenderer: win !== null && registry.hasSession(win.id),
          currentUrl: webContents?.getURL() ?? '',
          requestingUrl: details.requestingUrl ?? requestingOrigin,
          isMainFrame: details.isMainFrame,
          mediaTypes: details.mediaType ? [details.mediaType] : undefined,
        })
      })
      const voiceHotkeyOk = globalShortcut.register(config.voicePttHotkey, toggleVoice)
      console.log(
        `[aico] voice PTT hotkey ${config.voicePttHotkey}: ${
          voiceHotkeyOk
            ? 'registered'
            : 'unavailable (Wayland? bind a GNOME shortcut to toggle voice)'
        }`,
      )
    },
    stop: (): void => {
      // A secondary instance (single-instance lock denied) quits before the app is
      // ready, where globalShortcut would throw; it never registered any anyway.
      if (deps.app.isReady()) globalShortcut.unregisterAll()
    },
  }
}
