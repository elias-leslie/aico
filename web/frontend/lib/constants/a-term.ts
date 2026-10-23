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

/** Local fit-to-container debounce — short so xterm visually keeps up with drags. */
export const FIT_DEBOUNCE_MS = 16

/** Backend resize debounce for the active view — trailing edge only, so
 * SIGWINCH fires once at the end of a drag (or once the accessory bar, phone
 * keyboard or address bar settles) instead of bursting throughout. Each
 * trailing resize also re-claims the shared tmux window size. */
export const PTY_RESIZE_DEBOUNCE_MS = 120

/** Scroll threshold for touch scroll handling (pixels) */
export const SCROLL_THRESHOLD = 50

/** Copy-mode timeout in milliseconds (auto-exit after inactivity) */
export const COPY_MODE_TIMEOUT_MS = 10000

/** Terminal font: the vendored Iosevka (assets/fonts), as on the desktop. */
export const A_TERM_FONT_FAMILY = LANTERN_MONO_FAMILY

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
