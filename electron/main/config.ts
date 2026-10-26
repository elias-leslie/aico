// Every environment-derived setting of the main process, read once at start,
// so no feature module reads process.env itself. The child processes features
// start (terminal clients) get the environment handed in by the root.

import { join } from 'node:path'
import { defaultTetherSocketPath, knownTetherSockets, tetherSocketPath } from 'tether/client'

export type DisplayBackend = 'wayland' | 'x11'

/** `--ozone-platform=` on the command line, else AICO_OZONE_PLATFORM (the launcher's own switch), else Wayland when a Wayland display is set. */
export function displayBackend(argv: readonly string[], env: NodeJS.ProcessEnv): DisplayBackend {
  const flag = argv
    .find((a) => a.startsWith('--ozone-platform='))
    ?.slice('--ozone-platform='.length)
  const value = flag || env.AICO_OZONE_PLATFORM
  if (value === 'x11') return 'x11'
  if (value === 'wayland') return 'wayland'
  return env.WAYLAND_DISPLAY ? 'wayland' : 'x11'
}

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
  /** Every Tether instance Aico shows: the active one (`tetherSocket`). */
  readonly tetherSockets: readonly string[]
  /** Agent shares (`show.requested`) are accepted only from this user's tether@default. */
  readonly shareTetherSocket: string
  readonly exchangeRoot: string
  /** Where a pasted clipboard image is written for the terminal program to read (AICO_PASTED_IMAGES_DIR, AICO_PASTED_IMAGES_KEEP_HOURS). */
  readonly pastedImages: { readonly dir: string; readonly maxAgeMs: number }
  readonly nightshift: string
  /** The web app (AICO_WEB_URL): a tap on the push opens the waiting session there on the owner's phone (Nightshift allowlists the origin). */
  readonly webUrl: string
  /** The display protocol Electron runs on: window geometry comes from the compositor bridge on Wayland. */
  readonly displayBackend: DisplayBackend
  /** The Vite dev server, when running under it. */
  readonly rendererUrl: string | undefined
  readonly activationReadyFile: string | undefined
  /** The foreground runner registers its own PID, which exec hands to Electron. */
  readonly pidFile: string | undefined
}

/** `AICO_PASTED_IMAGES_KEEP_HOURS` in milliseconds; blank or not a positive number means a day. */
function pastedImageMaxAgeMs(raw: string | undefined): number {
  const hours = Number(raw)
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000
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
  argv: readonly string[] = [],
): AicoConfig {
  const stateDir = env.AICO_STATE_DIR ?? join(home, '.local', 'state', 'aico')
  const exchangeRoot = env.TETHER_EXCHANGE_ROOT || '/srv/workspaces/exchange'
  return Object.freeze({
    stateDir,
    dbPath: join(stateDir, 'aico.db'),
    listenerHost: env.AICO_SIDECAR_HOST ?? '127.0.0.1',
    listenerPort: listenerPort(env.AICO_SIDECAR_PORT),
    extensionIds: env.AICO_EXTENSION_IDS,
    layoutPath: join(env.XDG_RUNTIME_DIR || `/run/user/${uid ?? 1000}`, 'aico', 'layout.json'),
    tetherSocket: tetherSocketPath(env, uid),
    tetherSockets: Object.freeze(knownTetherSockets(env, uid)),
    shareTetherSocket: defaultTetherSocketPath(env, uid),
    exchangeRoot,
    pastedImages: {
      dir: env.AICO_PASTED_IMAGES_DIR || join(exchangeRoot, 'owner', 'pasted-images'),
      maxAgeMs: pastedImageMaxAgeMs(env.AICO_PASTED_IMAGES_KEEP_HOURS),
    },
    nightshift: join(home, '.local/bin/nightshift'),
    webUrl: (env.AICO_WEB_URL ?? 'https://aico.summitflow.dev').replace(/\/+$/, ''),
    displayBackend: displayBackend(argv, env),
    rendererUrl: env.ELECTRON_RENDERER_URL,
    activationReadyFile: env.AICO_ACTIVATION_READY_FILE,
    pidFile: env.AICO_PIDFILE,
  })
}
