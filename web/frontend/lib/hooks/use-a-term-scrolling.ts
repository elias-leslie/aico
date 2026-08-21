'use client'

import { useCallback } from 'react'
import { prefersLocalViewportScrollForMode } from '../utils/session-mode'
import {
  ARROW_DOWN,
  ARROW_UP,
  buildMouseWheelSequence,
  computeWheelLineDelta,
  getWheelMouseTickCount,
  isAlternateScreen,
  isMouseTrackingActive,
  pointToCell,
  refreshATermViewport,
  setupTouchHandlers,
} from './a-term-scrolling-utils'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

// Re-export public API used by tests
export {
  getTouchScrollEffectiveCellHeight,
  getTouchScrollLineDelta,
  initializeTouchTracking,
  refreshATermViewport,
} from './a-term-scrolling-utils'

interface UseATermScrollingOptions {
  wsRef: React.RefObject<WebSocket | null>
  aTermRef: React.RefObject<XtermATerm | null>
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
}

export function useATermScrolling({
  wsRef,
  aTermRef,
  isMobile,
  sessionMode,
  onRequestScrollbackOverlay,
  isScrollbackOverlayActive = false,
}: UseATermScrollingOptions): UseATermScrollingReturn {
  const sendArrowKey = useCallback(
    (direction: 'up' | 'down') => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      wsRef.current.send(direction === 'up' ? ARROW_UP : ARROW_DOWN)
    },
    [wsRef],
  )

  const sendMouseWheel = useCallback(
    (direction: 'up' | 'down', column: number, row: number) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      wsRef.current.send(buildMouseWheelSequence(direction, column, row))
    },
    [wsRef],
  )

  const setupScrolling = useCallback(
    (container: HTMLElement): ScrollingSetupResult => {
      const handleWheel = (e: WheelEvent) => {
        const aTerm = aTermRef.current
        if (!aTerm || e.deltaY === 0) return

        // The application asked for mouse reporting, so it scrolls itself:
        // an alternate-screen TUI has no tmux history to page through, and
        // wheel reports are its only scrollback. xterm.js drops the wheel
        // unless its render service has published device cell metrics, which
        // these panes never get, so send the reports here instead.
        if (isMouseTrackingActive(aTerm)) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          const screen = container.querySelector<HTMLElement>('.xterm-screen')
          const cellHeight = screen
            ? screen.clientHeight / Math.max(aTerm.rows, 1)
            : 0
          const ticks = getWheelMouseTickCount(
            e.deltaY,
            e.deltaMode,
            cellHeight,
            aTerm.rows,
          )
          if (ticks === 0) return
          const { column, row } = pointToCell(
            screen,
            aTerm,
            e.clientX,
            e.clientY,
          )
          const direction = e.deltaY > 0 ? 'down' : 'up'
          for (let tick = 0; tick < ticks; tick += 1) {
            sendMouseWheel(direction, column, row)
          }
          return
        }

        const prefersLocalViewportScroll =
          prefersLocalViewportScrollForMode(sessionMode)
        const isAltScreen = isAlternateScreen(aTerm)
        if (isAltScreen && !prefersLocalViewportScroll) return

        // TUI sessions: first upward wheel tick should open the overlay
        // anchored at the live bottom page. Do not also consume that tick
        // as history movement or the user lands above the current output.
        // Use sessionMode as the authoritative signal, not isAltScreen —
        // after a page refresh xterm.js hasn't received the alt-screen-enter
        // escape sequence yet, so isAltScreen is false even though the
        // session is a TUI.
        if (prefersLocalViewportScroll) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          if (e.deltaY < 0 && !isScrollbackOverlayActive) {
            onRequestScrollbackOverlay?.()
          }
          return
        }

        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()

        aTerm.scrollLines(computeWheelLineDelta(e.deltaY))
        refreshATermViewport(aTerm)
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
          aTermRef,
          sendArrowKey,
          sendMouseWheel,
          sessionMode,
          onRequestScrollbackOverlay,
          isScrollbackOverlayActive,
        })
      }

      return { wheelCleanup, touchCleanup }
    },
    [
      aTermRef,
      isMobile,
      isScrollbackOverlayActive,
      onRequestScrollbackOverlay,
      sessionMode,
      sendArrowKey,
      sendMouseWheel,
    ],
  )

  return { setupScrolling }
}
