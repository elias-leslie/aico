// Every environment-derived setting of the main process, read once at start,
// so no feature module reads process.env itself. The child processes features
// start (terminal PTYs, the sidecar) get the environment handed in by the root.

import { join } from 'node:path'
import { tetherSocketPath } from './tether-client'

export interface AicoConfig {
  readonly stateDir: string
  readonly dbPath: string
  readonly sidecarHost: string
  readonly sidecarPort: number
  /** $XDG_RUNTIME_DIR/aico/layout.json: the window picture agents read. */
  readonly layoutPath: string
  /** Tether's control socket (TETHER_SOCKET, TETHER_INSTANCE, XDG_RUNTIME_DIR). */
  readonly tetherSocket: string
  readonly nightshift: string
  /** a-term on the owner's phone; a tap on the push opens the waiting session there (Nightshift allowlists the origin). */
  readonly atermUrl: string
  /**
   * System-wide "indicate" hotkey. Works on X11 today; on Wayland (GNOME 46, no
   * GlobalShortcuts portal) globalShortcut silently no-ops — bind a GNOME custom
   * shortcut to a CLI that poke this same grab path instead (follow-on).
   */
  readonly selectionHotkey: string
  /** AICO_TERMINAL_TRANSPORT, when it forces a terminal transport over the setting. */
  readonly forcedTransport: 'attach' | 'control' | undefined
  /** The Vite dev server, when running under it. */
  readonly rendererUrl: string | undefined
  readonly activationReadyFile: string | undefined
  /** The foreground runner registers its own PID, which exec hands to Electron. */
  readonly pidFile: string | undefined
}

export function readConfig(
  env: NodeJS.ProcessEnv,
  home: string,
  uid: number | undefined,
): AicoConfig {
  const stateDir = env.AICO_STATE_DIR ?? join(home, '.local', 'state', 'aico')
  const forced = env.AICO_TERMINAL_TRANSPORT
  return Object.freeze({
    stateDir,
    dbPath: join(stateDir, 'aico.db'),
    sidecarHost: env.AICO_SIDECAR_HOST ?? '127.0.0.1',
    sidecarPort: Number(env.AICO_SIDECAR_PORT ?? 8005),
    layoutPath: join(env.XDG_RUNTIME_DIR || `/run/user/${uid ?? 1000}`, 'aico', 'layout.json'),
    tetherSocket: tetherSocketPath(env, uid),
    nightshift: join(home, '.local/bin/nightshift'),
    atermUrl: (env.AICO_ATERM_URL ?? 'https://terminal.summitflow.dev').replace(/\/+$/, ''),
    selectionHotkey: env.AICO_SELECTION_HOTKEY ?? 'CommandOrControl+Shift+Space',
    forcedTransport: forced === 'attach' || forced === 'control' ? forced : undefined,
    rendererUrl: env.ELECTRON_RENDERER_URL,
    activationReadyFile: env.AICO_ACTIVATION_READY_FILE,
    pidFile: env.AICO_PIDFILE,
  })
}
