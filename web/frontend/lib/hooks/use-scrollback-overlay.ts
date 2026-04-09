'use client'

import { useCallback, useRef, useState } from 'react'
import { isTuiSessionMode } from '../utils/session-mode'

interface ScrollbackPage {
  from_line: number
  lines: string[]
  total_lines: number
}

interface UseScrollbackOverlayOptions {
  wsRef: React.RefObject<WebSocket | null>
  sessionMode?: string
}

interface UseScrollbackOverlayReturn {
  isActive: boolean
  lines: string[]
  totalLines: number
  isLoading: boolean
  initialScrollLineDelta: number
  searchVersion: number
  activate: (initialScrollLineDelta?: number) => void
  deactivate: () => void
  getCachedLines: () => string[]
  handleScrollbackPage: (data: ScrollbackPage) => void
  /** Update cache from raw scrollback text (e.g. from scrollback_sync). */
  updateCacheFromSync: (scrollback: string) => void
}

const FETCH_COUNT = 5000

export function useScrollbackOverlay({
  wsRef,
  sessionMode,
}: UseScrollbackOverlayOptions): UseScrollbackOverlayReturn {
  const [isActive, setIsActive] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [totalLines, setTotalLines] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [initialScrollLineDelta, setInitialScrollLineDelta] = useState(0)
  const [searchVersion, setSearchVersion] = useState(0)
  const activeRef = useRef(false)

  const isTui = isTuiSessionMode(sessionMode)

  // Cached lines from server prefetch or periodic syncs.
  const cachedLinesRef = useRef<string[]>([])
  const cachedTotalLinesRef = useRef(0)

  const requestFreshData = useCallback(() => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          __ctrl: true,
          scroll_request: { count: FETCH_COUNT },
        }),
      )
    }
  }, [wsRef])

  const getCachedLines = useCallback(() => cachedLinesRef.current.slice(), [])

  const activate = useCallback((nextInitialScrollLineDelta = 0) => {
    if (!isTui || activeRef.current) return
    activeRef.current = true
    setInitialScrollLineDelta(nextInitialScrollLineDelta)
    setIsActive(true)

    // Show cached data instantly (no loading spinner)
    if (cachedLinesRef.current.length > 0) {
      setLines(cachedLinesRef.current.slice())
      setTotalLines(cachedTotalLinesRef.current)
      setIsLoading(false)
    } else {
      setIsLoading(true)
      setLines([])
    }

    // Always fetch fresh data — cache may be stale if the agent has
    // produced new output since the last sync. The server response
    // will update the displayed content via handleScrollbackPage.
    requestFreshData()
  }, [isTui, requestFreshData])

  const deactivate = useCallback(() => {
    activeRef.current = false
    setIsActive(false)
    setLines([])
    setTotalLines(0)
    setIsLoading(false)
    setInitialScrollLineDelta(0)
  }, [])

  const handleScrollbackPage = useCallback((data: ScrollbackPage) => {
    if (data.lines.length > 0) {
      setSearchVersion((current) => current + 1)
    }
    // Never shrink the cache — a small scroll_request response must not
    // overwrite a larger prefetch or sync that arrived earlier.
    if (data.lines.length > cachedLinesRef.current.length) {
      cachedLinesRef.current = data.lines
      cachedTotalLinesRef.current = data.total_lines
    } else if (data.total_lines > cachedTotalLinesRef.current) {
      cachedTotalLinesRef.current = data.total_lines
    }

    if (!activeRef.current) return
    if (data.lines.length === 0) {
      activeRef.current = false
      setIsActive(false)
      setIsLoading(false)
      setInitialScrollLineDelta(0)
      return
    }
    // Show whichever has more content: the incoming page or the cache
    const best = data.lines.length >= cachedLinesRef.current.length
      ? data.lines : cachedLinesRef.current
    setLines(best)
    setTotalLines(Math.max(data.total_lines, cachedTotalLinesRef.current))
    setIsLoading(false)
  }, [])

  const updateCacheFromSync = useCallback((scrollback: string) => {
    const parsed = scrollback.split(/\r?\n/)
    while (parsed.length > 0 && parsed.at(-1) === '') {
      parsed.pop()
    }
    if (parsed.length === 0) return

    setSearchVersion((current) => current + 1)
    cachedLinesRef.current = parsed
    cachedTotalLinesRef.current = parsed.length

    // If overlay is open, update displayed content so it stays current
    if (activeRef.current) {
      setLines(parsed)
      setTotalLines(parsed.length)
    }
  }, [])

  return {
    isActive,
    lines,
    totalLines,
    isLoading,
    initialScrollLineDelta,
    searchVersion,
    activate,
    deactivate,
    getCachedLines,
    handleScrollbackPage,
    updateCacheFromSync,
  }
}
