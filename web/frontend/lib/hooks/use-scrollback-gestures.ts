'use client'

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import {
  getTouchScrollEffectiveCellHeight,
  getTouchScrollLineDelta,
  refreshTerminalViewport,
} from './terminal-scrolling-utils'
import { getScrollbackOverlayWheelAction } from '../utils/scrollback-overlay-scroll'
import { shouldDismissScrollbackOverlayTouchGesture } from '../utils/scrollback-overlay-touch'
import { isTerminalBufferAtBottom } from './use-scrollback-terminal'

function stopAndPrevent(e: Event) {
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
}

interface UseScrollbackGesturesOptions {
  containerRef: RefObject<HTMLDivElement | null>
  isActive: boolean
  xtermRef: RefObject<Terminal | null>
  flushPendingLines: RefObject<(term: Terminal) => void>
  onDismiss: () => void
}

export function useScrollbackGestures({
  containerRef,
  isActive,
  xtermRef,
  flushPendingLines,
  onDismiss,
}: UseScrollbackGesturesOptions) {
  const stableDismiss = useRef(onDismiss)
  useEffect(() => {
    stableDismiss.current = onDismiss
  }, [onDismiss])

  // Wheel scroll + scroll-past-bottom dismissal
  useEffect(() => {
    const el = containerRef.current
    if (!el || !isActive) return

    const handleWheel = (e: WheelEvent) => {
      const term = xtermRef.current
      if (!term || e.deltaY === 0) return

      const action = getScrollbackOverlayWheelAction({
        deltaY: e.deltaY,
        isAtBottom: isTerminalBufferAtBottom(term),
      })
      stopAndPrevent(e)
      if (action.kind === 'dismiss') {
        stableDismiss.current()
        return
      }
      term.scrollLines(action.lineDelta)
      refreshTerminalViewport(term)
      flushPendingLines.current(term)
    }

    el.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', handleWheel, { capture: true })
  }, [isActive]) // eslint-disable-line react-hooks/exhaustive-deps

  // Touch scroll + scroll-past-bottom dismissal (mobile)
  useEffect(() => {
    const el = containerRef.current
    if (!el || !isActive) return

    let touchStartY: number | null = null
    let lastTouchY: number | null = null
    let pendingScrollDeltaY = 0
    let gestureStartedAtBottom = false
    let gestureLeftBottom = false

    const resetGesture = () => {
      touchStartY = null
      lastTouchY = null
      pendingScrollDeltaY = 0
      gestureStartedAtBottom = false
      gestureLeftBottom = false
    }

    const handleTouchStart = (e: TouchEvent) => {
      const term = xtermRef.current
      if (!term) return
      touchStartY = e.touches[0].clientY
      lastTouchY = touchStartY
      pendingScrollDeltaY = 0
      gestureStartedAtBottom = isTerminalBufferAtBottom(term)
      gestureLeftBottom = false
    }

    const handleTouchMove = (e: TouchEvent) => {
      const term = xtermRef.current
      if (!term || touchStartY === null || lastTouchY === null) return

      const currentY = e.touches[0].clientY
      pendingScrollDeltaY += lastTouchY - currentY
      lastTouchY = currentY

      const screen = el.querySelector<HTMLElement>('.xterm-screen')
      const cellHeight = screen ? screen.clientHeight / Math.max(term.rows, 1) : 0
      const lineDelta = getTouchScrollLineDelta(pendingScrollDeltaY, cellHeight)
      if (lineDelta === 0) return

      stopAndPrevent(e)
      term.scrollLines(lineDelta)
      refreshTerminalViewport(term)
      flushPendingLines.current(term)
      pendingScrollDeltaY -= lineDelta * getTouchScrollEffectiveCellHeight(cellHeight)

      if (!gestureLeftBottom && !isTerminalBufferAtBottom(term)) {
        gestureLeftBottom = true
      }
    }

    const handleTouchEnd = () => {
      const term = xtermRef.current
      if (
        term &&
        shouldDismissScrollbackOverlayTouchGesture({
          gestureStartedAtBottom,
          gestureLeftBottom,
          touchStartY,
          touchEndY: lastTouchY,
          isAtBottom: isTerminalBufferAtBottom(term),
        })
      ) {
        stableDismiss.current()
      }
      resetGesture()
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true })
    el.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true })
    el.addEventListener('touchcancel', handleTouchEnd, { passive: true, capture: true })
    return () => {
      el.removeEventListener('touchstart', handleTouchStart, { capture: true })
      el.removeEventListener('touchmove', handleTouchMove, { capture: true })
      el.removeEventListener('touchend', handleTouchEnd, { capture: true })
      el.removeEventListener('touchcancel', handleTouchEnd, { capture: true })
    }
  }, [isActive]) // eslint-disable-line react-hooks/exhaustive-deps
}
