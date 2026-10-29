import { BONE, INK } from '../../../../electron/shared/palette'
import { LANTERN_MONO_FAMILY } from './lantern'

/** WebSocket connection timeout in milliseconds */
export const CONNECTION_TIMEOUT = 10000

/** Scrollback buffer size until the server says how much history its seed
 * carries. Very large buffers slow xterm.js down as a session ages. */
export const SCROLLBACK = 10000

/** Mobile device width threshold in pixels */
export const MOBILE_WIDTH_THRESHOLD = 768

/** WebSocket close code for dead session */
export const WS_CLOSE_CODE_SESSION_DEAD = 4000

/** Client→server ping interval (ms) to prevent reverse proxy idle disconnects */
export const WS_CLIENT_PING_INTERVAL = 25000

/** Shortest wait between two local fits while the container keeps changing.
 * Short so xterm visually keeps up with a slow drag. */
export const FIT_DEBOUNCE_MS = 16

/** A fit that took T ms is followed by at least FIT_COST_RATIO x T ms of
 * other work, so a window that keeps changing size (a drag, a tiling
 * extension's animation) can never keep the page busy refitting more than
 * about a quarter of the time. A fit reflows the whole scrollback, and with
 * 20,000 lines that is tens to hundreds of ms each. */
export const FIT_COST_RATIO = 3

/** Smallest grid the view fits or claims. Anything narrower is a layout in
 * transit (a window mid-resize, a container not laid out yet), never a
 * terminal anyone reads: reflowing 20,000 history lines into 2 columns took
 * the page to 750 MB at once, and the program behind it redraws its whole
 * transcript at that width. */
export const MIN_FIT_COLS = 20
export const MIN_FIT_ROWS = 3

/** How much text either side of the hovered row the file-path links read as one
 * wrapped line (the web-links addon reads 2048). */
export const MAX_LINK_SCAN_CHARS = 4096

/** Backend resize debounce for the active view — trailing edge only, so
 * SIGWINCH fires once at the end of a drag (or once the accessory bar, phone
 * keyboard or address bar settles) instead of bursting throughout. Each
 * trailing resize also re-claims the shared tmux window size. */
export const PTY_RESIZE_DEBOUNCE_MS = 120

/** Scroll threshold for touch scroll handling (pixels) */
export const SCROLL_THRESHOLD = 50

/** Copy-mode timeout in milliseconds (auto-exit after inactivity) */
export const COPY_MODE_TIMEOUT_MS = 10000

/** Terminal font: the vendored JetBrains Mono (assets/fonts). */
export const TERMINAL_FONT_FAMILY = LANTERN_MONO_FAMILY

/** The terminal draws bone on ink with a bone cursor, like the desktop;
 * the ANSI colours stay xterm's own, as there. Search matches are selected,
 * so the selection is the search highlight: amber, kept while the search
 * field has focus, with bone text so coloured output stays readable on it. */
export const LANTERN_TERMINAL_THEME = {
  background: INK,
  foreground: BONE,
  cursor: BONE,
  cursorAccent: INK,
  selectionBackground: 'rgba(229, 166, 71, 0.38)',
  selectionForeground: BONE,
  selectionInactiveBackground: 'rgba(229, 166, 71, 0.3)',
} as const
