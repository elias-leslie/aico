/** WebSocket connection timeout in milliseconds */
export const CONNECTION_TIMEOUT = 10000

/** A-Term scrollback buffer size.
 * 10K lines balances history access with browser performance.
 * 100K caused progressive slowdown as xterm.js buffer management
 * and DOM overhead grew with session lifetime. */
export const SCROLLBACK = 10000

/** Mobile device width threshold in pixels */
export const MOBILE_WIDTH_THRESHOLD = 768

/** WebSocket close code for dead session */
export const WS_CLOSE_CODE_SESSION_DEAD = 4000

/** Client→server ping interval (ms) to prevent reverse proxy idle disconnects */
export const WS_CLIENT_PING_INTERVAL = 25000

/** Bytes between backpressure commit messages (Phase 1) */
export const BACKPRESSURE_COMMIT_INTERVAL = 256 * 1024

/** ResizeObserver debounce delay in milliseconds */
export const RESIZE_DEBOUNCE_MS = 150

/** Scroll threshold for touch scroll handling (pixels) */
export const SCROLL_THRESHOLD = 50

/** Copy-mode timeout in milliseconds (auto-exit after inactivity) */
export const COPY_MODE_TIMEOUT_MS = 10000

/** Layout modes supported by the desktop pane renderer. */
export type LayoutMode =
  | 'split-horizontal'
  | 'split-vertical'
  | 'split-main-side'
  | 'grid-2x2'
  | 'grid-4x1'
  | 'grid-3x2'
  | 'grid-2x3'

/** Grid layout types. */
export type GridLayoutMode = Extract<LayoutMode, `grid-${string}`>

/** Minimum viewport widths required for wider pane capacities. */
export const ULTRAWIDE_PANE_BREAKPOINT = 1920
export const FOUR_COLUMN_LAYOUT_BREAKPOINT = 1600

/** Minimum viewport widths required for each grid layout mode (in pixels) */
export const GRID_MIN_WIDTHS: Record<GridLayoutMode, number> = {
  'grid-2x2': 1280,
  'grid-4x1': FOUR_COLUMN_LAYOUT_BREAKPOINT,
  'grid-3x2': ULTRAWIDE_PANE_BREAKPOINT,
  'grid-2x3': ULTRAWIDE_PANE_BREAKPOINT,
} as const

/** Maximum number of panes allowed by the backend. */
export const MAX_PANES = 6

export function getPaneCapacityForViewport(viewportWidth: number): number {
  return viewportWidth >= MOBILE_WIDTH_THRESHOLD ? MAX_PANES : 4
}

export function getAvailableLayoutModes(
  paneCount: number,
  viewportWidth: number,
): LayoutMode[] {
  void viewportWidth
  // Guard: clamp to valid range so values above MAX_PANES don't fall through silently.
  const count = Math.min(paneCount, MAX_PANES)

  if (count <= 1) return ['split-horizontal']
  if (count === 2) return ['split-horizontal', 'split-vertical']
  if (count === 3)
    return ['split-horizontal', 'split-vertical', 'split-main-side']
  if (count === 4) return ['split-horizontal', 'grid-2x2']
  return ['split-horizontal', 'grid-3x2']
}

export function getDefaultLayoutMode(
  paneCount: number,
  viewportWidth: number,
): LayoutMode {
  const availableLayouts = getAvailableLayoutModes(paneCount, viewportWidth)
  if (paneCount <= 2) {
    return 'split-horizontal'
  }
  return availableLayouts[availableLayouts.length - 1] ?? 'split-horizontal'
}

/** Phosphor a-term theme colors */
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

export interface ATermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground?: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** Dracula theme */
export const DRACULA_THEME = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: 'rgba(68, 71, 90, 0.5)',
  selectionForeground: '#f8f8f2',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
} as const

/** Monokai theme */
export const MONOKAI_THEME = {
  background: '#272822',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#272822',
  selectionBackground: 'rgba(73, 72, 62, 0.5)',
  selectionForeground: '#f8f8f2',
  black: '#272822',
  red: '#f92672',
  green: '#a6e22e',
  yellow: '#f4bf75',
  blue: '#66d9ef',
  magenta: '#ae81ff',
  cyan: '#a1efe4',
  white: '#f8f8f2',
  brightBlack: '#75715e',
  brightRed: '#f92672',
  brightGreen: '#a6e22e',
  brightYellow: '#f4bf75',
  brightBlue: '#66d9ef',
  brightMagenta: '#ae81ff',
  brightCyan: '#a1efe4',
  brightWhite: '#f9f8f5',
} as const

/** Solarized Dark theme */
export const SOLARIZED_DARK_THEME = {
  background: '#002b36',
  foreground: '#839496',
  cursor: '#839496',
  cursorAccent: '#002b36',
  selectionBackground: 'rgba(7, 54, 66, 0.5)',
  selectionForeground: '#93a1a1',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
} as const

/** Tokyo Night theme */
export const TOKYO_NIGHT_THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: 'rgba(33, 38, 67, 0.5)',
  selectionForeground: '#c0caf5',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
} as const

/** All available themes */
export const A_TERM_THEMES = {
  phosphor: { name: 'Phosphor', theme: PHOSPHOR_THEME },
  dracula: { name: 'Dracula', theme: DRACULA_THEME },
  monokai: { name: 'Monokai', theme: MONOKAI_THEME },
  'solarized-dark': { name: 'Solarized Dark', theme: SOLARIZED_DARK_THEME },
  'tokyo-night': { name: 'Tokyo Night', theme: TOKYO_NIGHT_THEME },
} as const

export type ATermThemeId = keyof typeof A_TERM_THEMES
