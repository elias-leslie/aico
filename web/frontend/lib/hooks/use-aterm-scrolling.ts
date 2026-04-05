'use client'

import { useCallback, useEffect, useRef } from 'react'
import { COPY_MODE_TIMEOUT_MS } from '../constants/aterm'
import { prefersLocalViewportScrollForMode } from '../utils/session-mode'
import {
  ARROW_UP,
  ARROW_DOWN,
  COPY_MODE_ENTER,
  COPY_MODE_SCROLL_UP,
  COPY_MODE_SCROLL_DOWN,
  isAlternateScreen,
  computeWheelLineDelta,
  refreshATermViewport,
  setupTouchHandlers,
} from './aterm-scrolling-utils'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

// Re-export public API used by tests
export {
  getTouchScrollEffectiveCellHeight,
  getTouchScrollLineDelta,
  refreshATermViewport,
  initializeTouchTracking,
} from './aterm-scrolling-utils'

interface CopyModeState {
  inCopyMode: boolean
  timeout: ReturnType<typeof setTimeout> | null
}

interface UseATermScrollingOptions {
  wsRef: React.RefObject<WebSocket | null>
  atermRef: React.RefObject<XtermATerm | null>
  isMobile: boolean
  sessionMode?: string
  onRequestScrollbackOverlay?: (initialScrollLineDelta?: number) => void
  isScrollbackOverlayActive?: boolean
}

interface ScrollingSetupResult {
  wheelCleanup: () => void
  touchCleanup: () => void
}

interface UseATermScrollingReturn {
  setupScrolling: (container: HTMLElement) => ScrollingSetupResult
  resetCopyMode: () => void
}

export function useATermScrolling({
  wsRef,
  atermRef,
  isMobile,
  sessionMode,
  onRequestScrollbackOverlay,
  isScrollbackOverlayActive = false,
}: UseATermScrollingOptions): UseATermScrollingReturn {
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
        const aterm = atermRef.current
        if (!aterm || e.deltaY === 0) return
        const prefersLocalViewportScroll =
          prefersLocalViewportScrollForMode(sessionMode)
        const isAltScreen = isAlternateScreen(aterm)
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

        aterm.scrollLines(computeWheelLineDelta(e.deltaY))
        refreshATermViewport(aterm)
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
          atermRef,
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
      atermRef,
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
