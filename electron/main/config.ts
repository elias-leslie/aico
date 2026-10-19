// Every environment-derived setting of the main process, read once at start,
// so no feature module reads process.env itself. The child processes features
// start (terminal PTYs) get the environment handed in by the root.

import { join } from 'node:path'
import { knownTetherSockets, tetherSocketPath } from './tether-client'

export interface AicoConfig {
  readonly stateDir: string
  readonly dbPath: string
  /** The loopback listener (extension and `st selection send`); it keeps the
   * old sidecar's AICO_SIDECAR_* names, which `st selection` reads too. */
  readonly listenerHost: string
  readonly listenerPort: number
  /** Raw AICO_EXTENSION_IDS; the listener validates it. */
  readonly extensionIds: string | undefined
  /** $XDG_RUNTIME_DIR/aico/layout.json: the window picture agents read. */
  readonly layoutPath: string
  /** Tether's control socket (TETHER_SOCKET, TETHER_INSTANCE, XDG_RUNTIME_DIR). */
  readonly tetherSocket: string
  /** Every Tether instance Aico shows, active (`tetherSocket`) first: this user's own and the agent's (TETHER_AGENT_SOCKET). */
  readonly tetherSockets: readonly string[]
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

/** `AICO_SIDECAR_PORT` as a TCP port: unset means 8005; anything but plain
 * digits in 1-65535 (blank, 0, hex, exponents, spaces) is NaN, which the
 * listener refuses rather than binding some other port. */
function listenerPort(raw: string | undefined): number {
  if (raw === undefined) return 8005
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN
  return port >= 1 && port <= 65535 ? port : Number.NaN
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
    listenerHost: env.AICO_SIDECAR_HOST ?? '127.0.0.1',
    listenerPort: listenerPort(env.AICO_SIDECAR_PORT),
    extensionIds: env.AICO_EXTENSION_IDS,
    layoutPath: join(env.XDG_RUNTIME_DIR || `/run/user/${uid ?? 1000}`, 'aico', 'layout.json'),
    tetherSocket: tetherSocketPath(env, uid),
    tetherSockets: Object.freeze(knownTetherSockets(env, uid)),
    nightshift: join(home, '.local/bin/nightshift'),
    atermUrl: (env.AICO_ATERM_URL ?? 'https://terminal.summitflow.dev').replace(/\/+$/, ''),
    selectionHotkey: env.AICO_SELECTION_HOTKEY ?? 'CommandOrControl+Shift+Space',
    forcedTransport: forced === 'attach' || forced === 'control' ? forced : undefined,
    rendererUrl: env.ELECTRON_RENDERER_URL,
    activationReadyFile: env.AICO_ACTIVATION_READY_FILE,
    pidFile: env.AICO_PIDFILE,
  })
}
