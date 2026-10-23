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

/** Terminal font. */
export const A_TERM_FONT_FAMILY = "'JetBrains Mono', monospace"

/** Terminal colors. */
export const PHOSPHOR_THEME = {
  background: '#0a0e14',
  foreground: '#e6edf3',
  cursor: '#00ff9f',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0, 255, 159, 0.3)',
  selectionForeground: '#e6edf3',
  black: '#0f1419',
  red: '#f85149',
  green: '#00ff9f',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#e6edf3',
  brightBlack: '#7d8590',
  brightRed: '#ff7b72',
  brightGreen: '#39ffb3',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
} as const

/**
 * Height of whatever floats over the bottom of the terminal pane (the phone
 * compose box). The overlay publishes it on the document root; the pane's
 * floating controls lift themselves by it so they stay visible and tappable.
 */
export const BOTTOM_OVERLAY_HEIGHT_VAR = '--a-term-bottom-overlay-height'
