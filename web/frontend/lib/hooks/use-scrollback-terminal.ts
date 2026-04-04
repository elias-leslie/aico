'use client'

import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { TerminalTheme } from '../constants/terminal'
import { refreshTerminalViewport } from './terminal-scrolling-utils'
import { applyMobileTerminalTouchStyles } from '../utils/mobile-terminal-touch'
import {
  shouldDeferScrollbackOverlayWrite,
  shouldFlushPendingScrollbackOverlayWrite,
} from '../utils/scrollback-overlay-update'
import type { TerminalSearchMatch } from '../utils/terminal-search'
import { applyTerminalSearchSelection } from '../utils/terminal-search'

export function isTerminalBufferAtBottom(term: Terminal): boolean {
  const buf = term.buffer.active
  return buf.viewportY >= buf.baseY
}

export function applyInitialOverlayViewportScroll(
  term: Terminal,
  lineDelta: number,
): boolean {
  if (lineDelta === 0) return false
  term.scrollLines(lineDelta)
  return true
}

interface UseScrollbackTerminalOptions {
  isActive: boolean
  lines: string[]
  initialScrollLineDelta: number
  searchMatch: TerminalSearchMatch | null
  theme: TerminalTheme
  fontFamily: string
  fontSize: number
}

export function useScrollbackTerminal({
  isActive,
  lines,
  initialScrollLineDelta,
  searchMatch,
  theme,
  fontFamily,
  fontSize,
}: UseScrollbackTerminalOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const hasScrolledRef = useRef(false)
  const pendingLinesRef = useRef<string[]>([])
  const pendingInitialScrollLineDeltaRef = useRef(0)
  const currentSearchMatchRef = useRef<TerminalSearchMatch | null>(null)

  const writeLines = useRef((term: Terminal, lns: string[]) => {
    if (lns.length === 0) return
    if (
      shouldDeferScrollbackOverlayWrite({
        hasScrolled: hasScrolledRef.current,
        isAtBottom: isTerminalBufferAtBottom(term),
      })
    ) {
      pendingLinesRef.current = lns
      return
    }
    pendingLinesRef.current = []
    term.reset()
    term.write(lns.join('\r\n'), () => {
      term.scrollToBottom()
      if (applyInitialOverlayViewportScroll(term, pendingInitialScrollLineDeltaRef.current)) {
        pendingInitialScrollLineDeltaRef.current = 0
      }
      hasScrolledRef.current = true
      if (currentSearchMatchRef.current) {
        applyTerminalSearchSelection(term, currentSearchMatchRef.current)
      }
      refreshTerminalViewport(term)
    })
  })

  const flushPendingLines = useRef((term: Terminal) => {
    if (
      !shouldFlushPendingScrollbackOverlayWrite({
        hasPendingLines: pendingLinesRef.current.length > 0,
        isAtBottom: isTerminalBufferAtBottom(term),
      })
    ) {
      return
    }
    const nextLines = pendingLinesRef.current
    pendingLinesRef.current = []
    writeLines.current(term, nextLines)
  })

  // Create/destroy xterm instance when overlay activates/deactivates
  useEffect(() => {
    if (!isActive || !containerRef.current) {
      if (xtermRef.current) {
        xtermRef.current.dispose()
        xtermRef.current = null
        fitAddonRef.current = null
      }
      hasScrolledRef.current = false
      pendingLinesRef.current = []
      pendingInitialScrollLineDeltaRef.current = 0
      return
    }

    pendingInitialScrollLineDeltaRef.current = initialScrollLineDelta
    let disposed = false

    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(
      ([{ Terminal: XTerminal }, { FitAddon: XFitAddon }]) => {
        if (disposed || !containerRef.current) return
        const term = new XTerminal({
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
        applyMobileTerminalTouchStyles(containerRef.current)
        fit.fit()
        xtermRef.current = term
        fitAddonRef.current = fit
        if (pendingLinesRef.current.length > 0) {
          writeLines.current(term, pendingLinesRef.current)
        } else if (currentSearchMatchRef.current) {
          applyTerminalSearchSelection(term, currentSearchMatchRef.current)
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

  // Write lines when they change — queue if terminal not ready yet
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
    currentSearchMatchRef.current = searchMatch
    if (!xtermRef.current) return
    if (!searchMatch) {
      xtermRef.current.clearSelection()
      return
    }
    applyTerminalSearchSelection(xtermRef.current, searchMatch)
  }, [searchMatch])

  // Fit on resize
  useEffect(() => {
    if (!isActive) return
    const handleResize = () => fitAddonRef.current?.fit()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isActive])

  return { containerRef, xtermRef, flushPendingLines }
}
