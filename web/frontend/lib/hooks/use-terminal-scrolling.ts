'use client'

import { useCallback } from 'react'
import { controlWheelAction } from '../terminal/control-view'
import {
  ARROW_DOWN,
  ARROW_UP,
  buildMouseClickSequence,
  buildMouseWheelSequence,
  computeWheelLineDelta,
  getWheelMouseTickCount,
  isAlternateScreen,
  pointToCell,
  refreshTerminalViewport,
  setupTouchHandlers,
} from './terminal-scrolling-utils'

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

// Re-export public API used by tests
export {
  getTouchScrollEffectiveCellHeight,
  getTouchScrollLineDelta,
  initializeTouchTracking,
  refreshTerminalViewport,
} from './terminal-scrolling-utils'

interface UseTerminalScrollingOptions {
  wsRef: React.RefObject<WebSocket | null>
  terminalRef: React.RefObject<XtermTerminal | null>
  isMobile: boolean
  /** Whether the program asked for SGR mouse reports. */
  isSgrMouse?: () => boolean
}

interface ScrollingSetupResult {
  wheelCleanup: () => void
  touchCleanup: () => void
}

interface UseTerminalScrollingReturn {
  setupScrolling: (container: HTMLElement) => ScrollingSetupResult
}

export function useTerminalScrolling({
  wsRef,
  terminalRef,
  isMobile,
  isSgrMouse,
}: UseTerminalScrollingOptions): UseTerminalScrollingReturn {
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

  const sendMouseClick = useCallback(
    (column: number, row: number) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      wsRef.current.send(buildMouseClickSequence(column, row))
    },
    [wsRef],
  )

  const setupScrolling = useCallback(
    (container: HTMLElement): ScrollingSetupResult => {
      const sendWheelReports = (terminal: XtermTerminal, e: WheelEvent) => {
        const screen = container.querySelector<HTMLElement>('.xterm-screen')
        const cellHeight = screen
          ? screen.clientHeight / Math.max(terminal.rows, 1)
          : 0
        const ticks = getWheelMouseTickCount(
          e.deltaY,
          e.deltaMode,
          cellHeight,
          terminal.rows,
        )
        if (ticks === 0) return
        const { column, row } = pointToCell(
          screen,
          terminal,
          e.clientX,
          e.clientY,
        )
        const direction = e.deltaY > 0 ? 'down' : 'up'
        for (let tick = 0; tick < ticks; tick += 1) {
          sendMouseWheel(direction, column, row)
        }
      }

      // The wheel is routed here, ahead of xterm, whose own viewport would
      // otherwise scroll it (and skip any custom handler). Only a non-SGR
      // mouse report is left to xterm, which encodes it.
      const handleWheel = (e: WheelEvent) => {
        const terminal = terminalRef.current
        if (!terminal || e.deltaY === 0) return
        const action = controlWheelAction({
          mouseTracking: terminal.modes.mouseTrackingMode !== 'none',
          sgrMouse: isSgrMouse?.() ?? false,
          alternateScreen: isAlternateScreen(terminal),
        })
        if (action === 'xterm-report') return
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        if (action === 'forward-sgr') sendWheelReports(terminal, e)
        else if (action === 'scroll') {
          terminal.scrollLines(computeWheelLineDelta(e.deltaY))
          refreshTerminalViewport(terminal)
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
          terminalRef,
          sendArrowKey,
          sendMouseWheel,
          sendMouseClick,
          isSgrMouse,
        })
      }

      return { wheelCleanup, touchCleanup }
    },
    [
      terminalRef,
      isSgrMouse,
      isMobile,
      sendArrowKey,
      sendMouseClick,
      sendMouseWheel,
    ],
  )

  return { setupScrolling }
}
