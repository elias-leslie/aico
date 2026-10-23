'use client'

import { useCallback } from 'react'
import { controlWheelAction } from '../a-term/control-view'
import {
  ARROW_DOWN,
  ARROW_UP,
  buildMouseWheelSequence,
  computeWheelLineDelta,
  getWheelMouseTickCount,
  isAlternateScreen,
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
  /** Whether the program asked for SGR mouse reports. */
  isSgrMouse?: () => boolean
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
  isSgrMouse,
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
      const sendWheelReports = (aTerm: XtermATerm, e: WheelEvent) => {
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
        const { column, row } = pointToCell(screen, aTerm, e.clientX, e.clientY)
        const direction = e.deltaY > 0 ? 'down' : 'up'
        for (let tick = 0; tick < ticks; tick += 1) {
          sendMouseWheel(direction, column, row)
        }
      }

      // The wheel is routed here, ahead of xterm, whose own viewport would
      // otherwise scroll it (and skip any custom handler). Only a non-SGR
      // mouse report is left to xterm, which encodes it.
      const handleWheel = (e: WheelEvent) => {
        const aTerm = aTermRef.current
        if (!aTerm || e.deltaY === 0) return
        const action = controlWheelAction({
          mouseTracking: aTerm.modes.mouseTrackingMode !== 'none',
          sgrMouse: isSgrMouse?.() ?? false,
          alternateScreen: isAlternateScreen(aTerm),
        })
        if (action === 'xterm-report') return
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        if (action === 'forward-sgr') sendWheelReports(aTerm, e)
        else if (action === 'scroll') {
          aTerm.scrollLines(computeWheelLineDelta(e.deltaY))
          refreshATermViewport(aTerm)
        }
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
        })
      }

      return { wheelCleanup, touchCleanup }
    },
    [aTermRef, isSgrMouse, isMobile, sendArrowKey, sendMouseWheel],
  )

  return { setupScrolling }
}
