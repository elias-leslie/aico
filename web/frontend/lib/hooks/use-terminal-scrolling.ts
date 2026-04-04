'use client'

import type { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef } from 'react'
import { COPY_MODE_TIMEOUT_MS } from '../constants/terminal'
import { prefersLocalViewportScrollForMode } from '../utils/session-mode'
import {
  ARROW_UP,
  ARROW_DOWN,
  COPY_MODE_ENTER,
  COPY_MODE_SCROLL_UP,
  COPY_MODE_SCROLL_DOWN,
  isAlternateScreen,
  computeWheelLineDelta,
  refreshTerminalViewport,
  setupTouchHandlers,
} from './terminal-scrolling-utils'

// Re-export public API used by tests
export {
  getTouchScrollEffectiveCellHeight,
  getTouchScrollLineDelta,
  refreshTerminalViewport,
  initializeTouchTracking,
} from './terminal-scrolling-utils'

interface CopyModeState {
  inCopyMode: boolean
  timeout: ReturnType<typeof setTimeout> | null
}

interface UseTerminalScrollingOptions {
  wsRef: React.RefObject<WebSocket | null>
  terminalRef: React.RefObject<Terminal | null>
  isMobile: boolean
  sessionMode?: string
  onRequestScrollbackOverlay?: (initialScrollLineDelta?: number) => void
  isScrollbackOverlayActive?: boolean
}

interface ScrollingSetupResult {
  wheelCleanup: () => void
  touchCleanup: () => void
}

interface UseTerminalScrollingReturn {
  setupScrolling: (container: HTMLElement) => ScrollingSetupResult
  resetCopyMode: () => void
}

export function useTerminalScrolling({
  wsRef,
  terminalRef,
  isMobile,
  sessionMode,
  onRequestScrollbackOverlay,
  isScrollbackOverlayActive = false,
}: UseTerminalScrollingOptions): UseTerminalScrollingReturn {
  const copyModeStateRef = useRef<CopyModeState>({
    inCopyMode: false,
    timeout: null,
  })

  const sendArrowKey = useCallback(
    (direction: 'up' | 'down') => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      wsRef.current.send(direction === 'up' ? ARROW_UP : ARROW_DOWN)
    },
    [wsRef],
  )

  const enterCopyMode = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    const state = copyModeStateRef.current
    if (state.timeout) clearTimeout(state.timeout)
    if (!state.inCopyMode) {
      wsRef.current.send(COPY_MODE_ENTER)
      state.inCopyMode = true
    }
    state.timeout = setTimeout(() => {
      state.inCopyMode = false
      state.timeout = null
    }, COPY_MODE_TIMEOUT_MS)
  }, [wsRef])

  const sendCopyModeScroll = useCallback(
    (direction: 'up' | 'down') => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      wsRef.current.send(
        direction === 'up' ? COPY_MODE_SCROLL_UP : COPY_MODE_SCROLL_DOWN,
      )
    },
    [wsRef],
  )

  const resetCopyMode = useCallback(() => {
    const state = copyModeStateRef.current
    state.inCopyMode = false
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = null
    }
  }, [])

  const setupScrolling = useCallback(
    (container: HTMLElement): ScrollingSetupResult => {
      const handleWheel = (e: WheelEvent) => {
        const terminal = terminalRef.current
        if (!terminal || e.deltaY === 0) return
        const prefersLocalViewportScroll =
          prefersLocalViewportScrollForMode(sessionMode)
        const isAltScreen = isAlternateScreen(terminal)
        if (isAltScreen && !prefersLocalViewportScroll) return

        // TUI sessions: activate scrollback overlay on scroll-up.
        // Use sessionMode as the authoritative signal, not isAltScreen —
        // after a page refresh xterm.js hasn't received the alt-screen-enter
        // escape sequence yet, so isAltScreen is false even though the
        // session is a TUI.
        if (prefersLocalViewportScroll) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          if (e.deltaY < 0 && !isScrollbackOverlayActive) {
            onRequestScrollbackOverlay?.(computeWheelLineDelta(e.deltaY))
          }
          return
        }

        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()

        terminal.scrollLines(computeWheelLineDelta(e.deltaY))
        refreshTerminalViewport(terminal)
      }

      container.addEventListener('wheel', handleWheel, {
        passive: false,
        capture: true,
      })

      const wheelCleanup = () => {
        container.removeEventListener('wheel', handleWheel, { capture: true })
      }

      let touchCleanup = () => {}
      if (isMobile) {
        touchCleanup = setupTouchHandlers(container, {
          terminalRef,
          enterCopyMode,
          sendArrowKey,
          sendCopyModeScroll,
          resetCopyMode,
          sessionMode,
          onRequestScrollbackOverlay,
          isScrollbackOverlayActive,
        })
      }

      return { wheelCleanup, touchCleanup }
    },
    [
      terminalRef,
      isMobile,
      isScrollbackOverlayActive,
      onRequestScrollbackOverlay,
      sessionMode,
      enterCopyMode,
      resetCopyMode,
      sendArrowKey,
      sendCopyModeScroll,
    ],
  )

  useEffect(() => resetCopyMode, [resetCopyMode])

  return { setupScrolling, resetCopyMode }
}
