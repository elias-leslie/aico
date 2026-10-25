// Global shortcuts: the indicate (selection) hotkey, and unregistering at quit.

import type { App, GlobalShortcut, IpcMain } from 'electron'
import type { AicoConfig } from './config'

interface HotkeysDeps {
  /** The selection bus's indicate harvest. */
  grab(): Promise<void>
  config: Pick<AicoConfig, 'selectionHotkey' | 'displayBackend'>
  globalShortcut: Pick<GlobalShortcut, 'register' | 'unregisterAll'>
  app: Pick<App, 'isReady'>
}

export function createHotkeys(deps: HotkeysDeps) {
  const { config, globalShortcut } = deps
  /** The indicate accelerator that actually took; null before or when it did not. */
  let selection: string | null = null
  return {
    /** The indicate action itself: the GNOME shortcut's second launch ends up here (lifecycle). */
    indicate: (): void => void deps.grab(),
    registerSelection: (): void => {
      // Wayland: no globalShortcut. Electron 42 would open an xdg-desktop-portal
      // GlobalShortcuts session and report success at once, whether or not GNOME
      // ever binds the key (it asks the owner per app and matches the app id),
      // and nothing here could tell. A GNOME custom shortcut running
      // `aico-launch.sh --indicate` is deterministic: scripts/aico-hotkey.sh.
      if (config.displayBackend === 'wayland') {
        console.log('[aico] selection hotkey: GNOME custom shortcut (scripts/aico-hotkey.sh)')
        return
      }
      // X11: the system-wide indicate hotkey. Logs whether the grab actually took.
      const hotkeyOk = globalShortcut.register(config.selectionHotkey, () => void deps.grab())
      selection = hotkeyOk ? config.selectionHotkey : null
      console.log(
        `[aico] selection hotkey ${config.selectionHotkey}: ${
          hotkeyOk ? 'registered' : 'unavailable (another app holds it)'
        }`,
      )
    },
    /** Windows label "Indicate selection" with the key that took, or none. */
    registerIpc: (ipcMain: Pick<IpcMain, 'handle'>): void => {
      ipcMain.handle('hotkeys:selection', () => selection)
    },
    stop: (): void => {
      // A secondary instance (single-instance lock denied) quits before the app is
      // ready, where globalShortcut would throw; it never registered any anyway.
      if (deps.app.isReady()) globalShortcut.unregisterAll()
    },
  }
}
