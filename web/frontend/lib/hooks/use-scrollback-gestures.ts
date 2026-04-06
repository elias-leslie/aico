'use client'

import { useEffect, useEffectEvent } from 'react'
import type { RefObject } from 'react'
import {
  getTouchScrollEffectiveCellHeight,
  getTouchScrollLineDelta,
  refreshATermViewport,
} from './a-term-scrolling-utils'
import { getScrollbackOverlayWheelAction } from '../utils/scrollback-overlay-scroll'
import { shouldDismissScrollbackOverlayTouchGesture } from '../utils/scrollback-overlay-touch'
import { isATermBufferAtBottom } from './use-scrollback-a-term'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

function stopAndPrevent(e: Event) {
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
}

function readRef<T>(ref: RefObject<T | null>): T | null {
  return ref.current
}

interface UseScrollbackGesturesOptions {
  containerRef: RefObject<HTMLDivElement | null>
  isActive: boolean
  xtermRef: RefObject<XtermATerm | null>
  flushPendingLines: RefObject<(term: XtermATerm) => void>
  onDismiss: () => void
}

export function useScrollbackGestures({
  containerRef,
  isActive,
  xtermRef,
  flushPendingLines,
  onDismiss,
}: UseScrollbackGesturesOptions) {
  const dismiss = useEffectEvent(onDismiss)

  // Wheel scroll + scroll-past-bottom dismissal
  useEffect(() => {
    const el = readRef(containerRef)
    if (!el || !isActive) return

    const handleWheel = (e: WheelEvent) => {
      const term = readRef(xtermRef)
      if (!term || e.deltaY === 0) return
      const flush = readRef(flushPendingLines)

      const action = getScrollbackOverlayWheelAction({
        deltaY: e.deltaY,
        isAtBottom: isATermBufferAtBottom(term),
      })
      stopAndPrevent(e)
      if (action.kind === 'dismiss') {
        dismiss()
        return
      }
      term.scrollLines(action.lineDelta)
      refreshATermViewport(term)
      flush?.(term)
    }

    el.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', handleWheel, { capture: true })
  }, [containerRef, flushPendingLines, isActive, xtermRef])

  // Touch scroll + scroll-past-bottom dismissal (mobile)
  useEffect(() => {
    const el = readRef(containerRef)
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
      const term = readRef(xtermRef)
      if (!term) return
      touchStartY = e.touches[0].clientY
      lastTouchY = touchStartY
      pendingScrollDeltaY = 0
      gestureStartedAtBottom = isATermBufferAtBottom(term)
      gestureLeftBottom = false
    }

    const handleTouchMove = (e: TouchEvent) => {
      const term = readRef(xtermRef)
      if (!term || touchStartY === null || lastTouchY === null) return
      const flush = readRef(flushPendingLines)

      const currentY = e.touches[0].clientY
      pendingScrollDeltaY += lastTouchY - currentY
      lastTouchY = currentY

      const screen = el.querySelector<HTMLElement>('.xterm-screen')
      const cellHeight = screen ? screen.clientHeight / Math.max(term.rows, 1) : 0
      const lineDelta = getTouchScrollLineDelta(pendingScrollDeltaY, cellHeight)
      if (lineDelta === 0) return

      stopAndPrevent(e)
      term.scrollLines(lineDelta)
      refreshATermViewport(term)
      flush?.(term)
      pendingScrollDeltaY -= lineDelta * getTouchScrollEffectiveCellHeight(cellHeight)

      if (!gestureLeftBottom && !isATermBufferAtBottom(term)) {
        gestureLeftBottom = true
      }
    }

    const handleTouchEnd = () => {
      const term = readRef(xtermRef)
      if (
        term &&
        shouldDismissScrollbackOverlayTouchGesture({
          gestureStartedAtBottom,
          gestureLeftBottom,
          touchStartY,
          touchEndY: lastTouchY,
          isAtBottom: isATermBufferAtBottom(term),
        })
      ) {
        dismiss()
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
  }, [containerRef, flushPendingLines, isActive, xtermRef])
}
