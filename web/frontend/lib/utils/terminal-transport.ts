/**
 * How panes reach their tmux session.
 *
 * `new` (the default) uses tmux control mode: the backend streams the pane's
 * own output, so xterm keeps real scrollback and sees the program's modes.
 * `classic` is the old tmux attach with the scrollback overlay, kept for
 * instant rollback. The server can also force classic (A_TERM_TERMINAL_TRANSPORT).
 */
export const SCROLLBACK_MODE_OPTIONS = ['new', 'classic'] as const

export type ScrollbackMode = (typeof SCROLLBACK_MODE_OPTIONS)[number]
export type TerminalTransport = 'control' | 'attach'

export const SCROLLBACK_MODE_STORAGE_KEY = 'a-term-scrollback-mode'

/** History kept in a control-mode terminal; the backend seeds the same. */
export const CONTROL_SCROLLBACK_LINES = 20_000

export function getScrollbackMode(): ScrollbackMode {
  if (typeof window === 'undefined') return 'new'
  try {
    const stored = window.localStorage.getItem(SCROLLBACK_MODE_STORAGE_KEY)
    return stored === 'classic' ? 'classic' : 'new'
  } catch {
    return 'new'
  }
}

export function setScrollbackMode(value: ScrollbackMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SCROLLBACK_MODE_STORAGE_KEY, value)
  } catch {
    // Storage unavailable (private mode) — the choice just won't persist.
  }
}

export function requestedTransport(
  mode: ScrollbackMode = getScrollbackMode(),
): TerminalTransport {
  return mode === 'classic' ? 'attach' : 'control'
}
