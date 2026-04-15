'use client'

import type { FitAddon } from '@xterm/addon-fit'
import { useEffect, useRef } from 'react'
import type { ATermTheme } from '../constants/a-term'
import { getATermBufferLines } from '../utils/a-term-buffer'
import {
  applyATermSearchSelection,
  findATermSearchMatches,
} from '../utils/a-term-search'
import { applyMobileATermTouchStyles } from '../utils/mobile-a-term-touch'
import { refreshATermViewport } from './a-term-scrolling-utils'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

export function isATermBufferAtBottom(term: XtermATerm): boolean {
  const buf = term.buffer.active
  return buf.viewportY >= buf.baseY
}

export function applyInitialOverlayViewportScroll(
  term: XtermATerm,
  lineDelta: number,
): boolean {
  if (lineDelta === 0) return false
  term.scrollLines(lineDelta)
  return true
}

export function getOverlayViewportRestoreLine(
  previousViewportY: number,
  nextBaseY: number,
): number {
  return Math.min(previousViewportY, nextBaseY)
}

interface UseScrollbackATermOptions {
  isActive: boolean
  lines: string[]
  initialScrollLineDelta: number
  searchQuery: string
  searchActiveIndex: number
  theme: ATermTheme
  fontFamily: string
  fontSize: number
}

export function applyOverlaySearchSelection(
  term: XtermATerm,
  query: string,
  activeIndex: number,
): boolean {
  const trimmedQuery = query.trim()
  if (!trimmedQuery || activeIndex < 0) {
    term.clearSelection()
    return false
  }

  const matches = findATermSearchMatches(
    getATermBufferLines(term),
    trimmedQuery,
  )
  if (matches.length === 0) {
    term.clearSelection()
    return false
  }

  const nextIndex = Math.min(activeIndex, matches.length - 1)
  applyATermSearchSelection(term, matches[nextIndex])
  return true
}

export function useScrollbackATerm({
  isActive,
  lines,
  initialScrollLineDelta,
  searchQuery,
  searchActiveIndex,
  theme,
  fontFamily,
  fontSize,
}: UseScrollbackATermOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XtermATerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const pendingLinesRef = useRef<string[]>([])
  const pendingInitialScrollLineDeltaRef = useRef(0)
  const currentSearchQueryRef = useRef('')
  const currentSearchIndexRef = useRef(-1)

  const writeLines = useRef((term: XtermATerm, lns: string[]) => {
    if (lns.length === 0) return
    pendingLinesRef.current = []
    const wasAtBottom = isATermBufferAtBottom(term)
    const previousViewportY = term.buffer.active.viewportY
    term.reset()
    term.write(lns.join('\r\n'), () => {
      if (wasAtBottom) {
        term.scrollToBottom()
        if (
          applyInitialOverlayViewportScroll(
            term,
            pendingInitialScrollLineDeltaRef.current,
          )
        ) {
          pendingInitialScrollLineDeltaRef.current = 0
        }
      } else {
        term.scrollToLine(
          getOverlayViewportRestoreLine(
            previousViewportY,
            term.buffer.active.baseY,
          ),
        )
      }
      if (currentSearchQueryRef.current && currentSearchIndexRef.current >= 0) {
        applyOverlaySearchSelection(
          term,
          currentSearchQueryRef.current,
          currentSearchIndexRef.current,
        )
      }
      refreshATermViewport(term)
    })
  })

  const flushPendingLines = useRef((_term: XtermATerm) => {})

  // Create/destroy xterm instance when overlay activates/deactivates
  useEffect(() => {
    if (!isActive || !containerRef.current) {
      if (xtermRef.current) {
        xtermRef.current.dispose()
        xtermRef.current = null
        fitAddonRef.current = null
      }
      pendingLinesRef.current = []
      pendingInitialScrollLineDeltaRef.current = 0
      return
    }

    pendingInitialScrollLineDeltaRef.current = initialScrollLineDelta
    let disposed = false

    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(
      ([xtermModule, { FitAddon: XFitAddon }]) => {
        if (disposed || !containerRef.current) return
        const term = new xtermModule.Terminal({
          fontSize,
          fontFamily,
          theme,
          scrollback: 50000,
          disableStdin: true,
          cursorStyle: 'bar',
          cursorBlink: false,
          cursorInactiveStyle: 'none',
        })
        const fit = new XFitAddon()
        term.loadAddon(fit)
        term.open(containerRef.current)
        applyMobileATermTouchStyles(containerRef.current)
        fit.fit()
        xtermRef.current = term
        fitAddonRef.current = fit
        if (pendingLinesRef.current.length > 0) {
          writeLines.current(term, pendingLinesRef.current)
        } else if (
          currentSearchQueryRef.current &&
          currentSearchIndexRef.current >= 0
        ) {
          applyOverlaySearchSelection(
            term,
            currentSearchQueryRef.current,
            currentSearchIndexRef.current,
          )
        }
      },
    )

    return () => {
      disposed = true
      if (xtermRef.current) {
        xtermRef.current.dispose()
        xtermRef.current = null
        fitAddonRef.current = null
      }
    }
  }, [isActive, initialScrollLineDelta, fontSize, fontFamily, theme])

  // Write lines when they change — queue if a-term not ready yet
  useEffect(() => {
    if (lines.length === 0) return
    const term = xtermRef.current
    if (term) {
      writeLines.current(term, lines)
    } else {
      pendingLinesRef.current = lines
    }
  }, [lines])

  useEffect(() => {
    currentSearchQueryRef.current = searchQuery
    currentSearchIndexRef.current = searchActiveIndex
    if (!xtermRef.current) return
    if (!searchQuery || searchActiveIndex < 0) {
      xtermRef.current.clearSelection()
      return
    }
    applyOverlaySearchSelection(
      xtermRef.current,
      searchQuery,
      searchActiveIndex,
    )
  }, [searchQuery, searchActiveIndex])

  // Fit on resize
  useEffect(() => {
    if (!isActive) return
    const handleResize = () => fitAddonRef.current?.fit()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isActive])

  return { containerRef, xtermRef, flushPendingLines }
}
