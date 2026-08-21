'use client'

import { useCallback, useRef } from 'react'

/** How long a tmux answer stays good enough to decide a gesture with. */
const PANE_MODE_MAX_AGE_MS = 1500

export interface PaneMode {
  alternateScreen: boolean
  mouseReporting: boolean
}

export interface PaneModeMessage {
  alternate_screen: boolean
  mouse_reporting: boolean
}

interface UsePaneModeReturn {
  /** Record a pane_mode control frame from the session. */
  handlePaneMode: (data: PaneModeMessage) => void
  /** Ask the session for the pane's state unless a fresh answer is in hand. */
  requestPaneMode: () => void
  /**
   * True when the program owns its own scrollback, false when tmux holds the
   * history, or null while the answer is unknown or stale — callers fall back
   * to what xterm.js has observed in that case.
   */
  paneOwnsScrollback: () => boolean | null
}

/**
 * Track who owns a pane's scrollback, straight from tmux.
 *
 * The browser cannot answer this from its own xterm: an attached tmux client
 * sits in the alternate screen for the whole session, and the mouse mode it
 * observes comes and goes as tmux redraws. tmux tracks the pane's own state,
 * so ask the session and cache the answer for the length of a gesture.
 */
export function usePaneMode(
  wsRef: React.RefObject<WebSocket | null>,
): UsePaneModeReturn {
  const modeRef = useRef<PaneMode | null>(null)
  const receivedAtRef = useRef(0)
  const requestedAtRef = useRef(0)

  const handlePaneMode = useCallback((data: PaneModeMessage) => {
    modeRef.current = {
      alternateScreen: Boolean(data.alternate_screen),
      mouseReporting: Boolean(data.mouse_reporting),
    }
    receivedAtRef.current = Date.now()
  }, [])

  const requestPaneMode = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (modeRef.current && now - receivedAtRef.current < PANE_MODE_MAX_AGE_MS) {
      return
    }
    // One request per staleness window, so a fling does not spam the session.
    if (now - requestedAtRef.current < PANE_MODE_MAX_AGE_MS) return
    requestedAtRef.current = now
    wsRef.current.send(
      JSON.stringify({ __ctrl: true, pane_mode_request: true }),
    )
  }, [wsRef])

  const paneOwnsScrollback = useCallback((): boolean | null => {
    const mode = modeRef.current
    if (!mode) return null
    if (Date.now() - receivedAtRef.current >= PANE_MODE_MAX_AGE_MS) return null
    return mode.alternateScreen && mode.mouseReporting
  }, [])

  return { handlePaneMode, requestPaneMode, paneOwnsScrollback }
}
