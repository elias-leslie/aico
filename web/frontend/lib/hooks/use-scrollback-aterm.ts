'use client'

import { useEffect, useRef } from 'react'
import type { FitAddon } from '@xterm/addon-fit'
import type { ATermTheme } from '../constants/aterm'
import { refreshATermViewport } from './aterm-scrolling-utils'
import { applyMobileATermTouchStyles } from '../utils/mobile-aterm-touch'
import {
  shouldDeferScrollbackOverlayWrite,
  shouldFlushPendingScrollbackOverlayWrite,
} from '../utils/scrollback-overlay-update'
import type { ATermSearchMatch } from '../utils/aterm-search'
import { applyATermSearchSelection } from '../utils/aterm-search'

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

interface UseScrollbackATermOptions {
  isActive: boolean
  lines: string[]
  initialScrollLineDelta: number
  searchMatch: ATermSearchMatch | null
  theme: ATermTheme
  fontFamily: string
  fontSize: number
}

export function useScrollbackATerm({
  isActive,
  lines,
  initialScrollLineDelta,
  searchMatch,
  theme,
  fontFamily,
  fontSize,
}: UseScrollbackATermOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XtermATerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const hasScrolledRef = useRef(false)
  const pendingLinesRef = useRef<string[]>([])
  const pendingInitialScrollLineDeltaRef = useRef(0)
  const currentSearchMatchRef = useRef<ATermSearchMatch | null>(null)

  const writeLines = useRef((term: XtermATerm, lns: string[]) => {
    if (lns.length === 0) return
    if (
      shouldDeferScrollbackOverlayWrite({
        hasScrolled: hasScrolledRef.current,
        isAtBottom: isATermBufferAtBottom(term),
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
        applyATermSearchSelection(term, currentSearchMatchRef.current)
      }
      refreshATermViewport(term)
    })
  })

  const flushPendingLines = useRef((term: XtermATerm) => {
    if (
      !shouldFlushPendingScrollbackOverlayWrite({
        hasPendingLines: pendingLinesRef.current.length > 0,
        isAtBottom: isATermBufferAtBottom(term),
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
        } else if (currentSearchMatchRef.current) {
          applyATermSearchSelection(term, currentSearchMatchRef.current)
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

  // Write lines when they change — queue if aterm not ready yet
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
    applyATermSearchSelection(xtermRef.current, searchMatch)
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
