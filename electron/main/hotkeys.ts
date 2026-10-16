// Global shortcuts: the indicate (selection) hotkey, and unregistering at quit.

import type { App, GlobalShortcut } from 'electron'
import type { AicoConfig } from './config'

interface HotkeysDeps {
  /** The selection bus's indicate harvest. */
  grab(): Promise<void>
  config: Pick<AicoConfig, 'selectionHotkey'>
  globalShortcut: Pick<GlobalShortcut, 'register' | 'unregisterAll'>
  app: Pick<App, 'isReady'>
}

export function createHotkeys(deps: HotkeysDeps) {
  const { config, globalShortcut } = deps
  return {
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
    stop: (): void => {
      // A secondary instance (single-instance lock denied) quits before the app is
      // ready, where globalShortcut would throw; it never registered any anyway.
      if (deps.app.isReady()) globalShortcut.unregisterAll()
    },
  }
}
