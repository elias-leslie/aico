'use client'

import { useCallback, useRef } from 'react'
import { ScrollbackLineCache } from '../scrollback-cache'

interface ViewportInit {
  lines: string
  cursor_position?: { x: number; y: number }
  total_lines: number
  viewport_start_line: number
}

interface ScrollbackPage {
  from_line: number
  lines: string[]
  total_lines: number
}

interface UseScrollbackPagerOptions {
  wsRef: React.RefObject<WebSocket | null>
  onWrite?: (data: string) => void
}

interface UseScrollbackPagerReturn {
  handleViewportInit: (data: ViewportInit) => void
  handleScrollbackPage: (data: ScrollbackPage) => void
  onScrollPositionChanged: (viewportTopLine: number) => void
  cache: React.RefObject<ScrollbackLineCache>
  reset: () => void
}

const PAGE_SIZE = 100
const PREFETCH_PAGES = 1
const DEBOUNCE_MS = 100

export function useScrollbackPager({
  wsRef,
  onWrite,
}: UseScrollbackPagerOptions): UseScrollbackPagerReturn {
  const cacheRef = useRef(new ScrollbackLineCache())
  const totalLinesRef = useRef(0)
  const viewportStartRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sendScrollRequest = useCallback(
    (fromLine: number, count: number) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (cacheRef.current.isRequestPending(fromLine, count)) return
      if (cacheRef.current.hasRange(fromLine, count)) return

      cacheRef.current.markRequestPending(fromLine, count)
      ws.send(
        JSON.stringify({
          __ctrl: true,
          scroll_request: { from_line: fromLine, count },
        }),
      )
    },
    [wsRef],
  )

  const handleViewportInit = useCallback(
    (data: ViewportInit) => {
      totalLinesRef.current = data.total_lines
      viewportStartRef.current = data.viewport_start_line
      onWrite?.(data.lines)
    },
    [onWrite],
  )

  const handleScrollbackPage = useCallback((data: ScrollbackPage) => {
    totalLinesRef.current = data.total_lines
    cacheRef.current.setLines(data.from_line, data.lines)
  }, [])

  const onScrollPositionChanged = useCallback(
    (viewportTopLine: number) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      debounceTimerRef.current = setTimeout(() => {
        // Request uncached lines around the viewport position
        const fromLine = Math.max(0, viewportTopLine - PAGE_SIZE)

        if (!cacheRef.current.hasRange(fromLine, PAGE_SIZE)) {
          sendScrollRequest(fromLine, PAGE_SIZE)
        }

        // Prefetch ahead
        const prefetchFrom = Math.max(0, fromLine - PAGE_SIZE * PREFETCH_PAGES)
        if (
          prefetchFrom >= 0 &&
          !cacheRef.current.hasRange(prefetchFrom, PAGE_SIZE)
        ) {
          sendScrollRequest(prefetchFrom, PAGE_SIZE)
        }
      }, DEBOUNCE_MS)
    },
    [sendScrollRequest],
  )

  const reset = useCallback(() => {
    cacheRef.current.clear()
    totalLinesRef.current = 0
    viewportStartRef.current = 0
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  return {
    handleViewportInit,
    handleScrollbackPage,
    onScrollPositionChanged,
    cache: cacheRef,
    reset,
  }
}
