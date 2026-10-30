import type { FitAddon } from '@xterm/addon-fit'
import { useCallback, useEffect, useRef } from 'react'
import {
  FIT_COST_RATIO,
  FIT_DEBOUNCE_MS,
  PTY_RESIZE_DEBOUNCE_MS,
} from '../constants/terminal'
import { fitTerminal, usableDimensions } from '../terminal/fit'

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

export interface TerminalResizeOptions {
  terminalRef: React.MutableRefObject<XtermTerminal | null>
  fitAddonRef: React.MutableRefObject<InstanceType<typeof FitAddon> | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  wsRef: React.MutableRefObject<WebSocket | null>
  /** This view may claim the shared size at all (not an observer). */
  canClaim?: boolean
  /** This view holds the shared size: its own size changes claim again. */
  holdsSize?: boolean
  /** Another client holds the size: show the session at this size instead of
   * fitting this view's container (null: fit). */
  viewSize?: { cols: number; rows: number } | null
}

export type ViewportEventTarget = Pick<
  Window,
  'addEventListener' | 'removeEventListener'
>

export function attachViewportResizeListeners(
  onViewportChange: () => void,
  viewport: ViewportEventTarget | null = window.visualViewport,
) {
  window.addEventListener('resize', onViewportChange, { passive: true })
  window.addEventListener('orientationchange', onViewportChange, {
    passive: true,
  })

  viewport?.addEventListener('resize', onViewportChange, { passive: true })
  viewport?.addEventListener('scroll', onViewportChange, { passive: true })

  return () => {
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('orientationchange', onViewportChange)
    viewport?.removeEventListener('resize', onViewportChange)
    viewport?.removeEventListener('scroll', onViewportChange)
  }
}

/**
 * Hook to manage terminal resizing with ResizeObserver and WebSocket dimension updates.
 *
 * Two stages: the local xterm fit is throttled (at most one pending fit,
 * reading the container's size when it runs, spaced by FIT_COST_RATIO times
 * what the last fit cost) so a window that keeps changing size cannot keep the
 * page refitting, and the backend message only fires on the trailing edge —
 * SIGWINCH mid-drag causes shells with fancy prompts and heavy TUIs (Claude
 * Code, Codex CLI) to redraw their whole transcript repeatedly. The shell only
 * cares about the final size. The claim waits for the pending fit and sends
 * the size it just fitted. A container too small to be a terminal is neither
 * fitted nor claimed.
 *
 * Looking does not claim. Only the view that holds the size (`holdsSize`)
 * sends its size changes, and every size it sends is also a claim on the
 * shared tmux window. The holder's container changes size without the owner
 * doing anything (phone accessory bar or keyboard, address-bar collapse,
 * rotation, desktop drag); if those only resized this view's PTY client, tmux
 * would keep the older claimed window size and fill the difference with its
 * dot pattern. Identical sizes are deduped. A view that does not hold the size
 * shows the session at its size (`viewSize`) and claims only through
 * `handleResize` (the owner typed, pasted or pressed Use here).
 */
export function useTerminalResize(options: TerminalResizeOptions) {
  const {
    terminalRef,
    fitAddonRef,
    containerRef,
    wsRef,
    canClaim = true,
    holdsSize = true,
    viewSize = null,
  } = options
  const viewSizeRef = useRef(viewSize)
  viewSizeRef.current = viewSize
  // Last size this view claimed on the current socket. A new socket or a new
  // activation always claims again (see handleResize).
  const lastClaimRef = useRef<{
    ws: WebSocket | null
    cols: number
    rows: number
  }>({ ws: null, cols: 0, rows: 0 })

  const sendClaim = useCallback(
    (force: boolean): void => {
      if (!canClaim) return
      const ws = wsRef.current
      if (ws?.readyState !== WebSocket.OPEN) return
      const dims = fitAddonRef.current
        ? usableDimensions(fitAddonRef.current)
        : null
      if (!dims) return
      const last = lastClaimRef.current
      if (
        !force &&
        last.ws === ws &&
        dims.cols === last.cols &&
        dims.rows === last.rows
      )
        return
      lastClaimRef.current = { ws, cols: dims.cols, rows: dims.rows }
      ws.send(
        JSON.stringify({
          __ctrl: true,
          resize: { cols: dims.cols, rows: dims.rows },
          claim: true,
        }),
      )
    },
    [canClaim, fitAddonRef, wsRef],
  )

  // The owner used this view (typed, pasted, Use here): fit it and claim the
  // shared tmux window size for it, even if the size equals the last claim
  // (another client may have claimed since).
  const handleResize = useCallback(() => {
    if (!fitAddonRef.current || !terminalRef.current) return
    if (!fitTerminal(fitAddonRef.current)) return
    sendClaim(true)
  }, [terminalRef, fitAddonRef, sendClaim])

  // Show the session at the holder's size; once it is no longer shown at it,
  // fit this view again.
  const viewCols = viewSize?.cols ?? 0
  const viewRows = viewSize?.rows ?? 0
  const shownRef = useRef(false)
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    if (viewCols > 0 && viewRows > 0) {
      shownRef.current = true
      if (term.cols !== viewCols || term.rows !== viewRows)
        term.resize(viewCols, viewRows)
    } else if (shownRef.current) {
      shownRef.current = false
      if (fitAddonRef.current) fitTerminal(fitAddonRef.current)
    }
  }, [fitAddonRef, terminalRef, viewCols, viewRows])

  useEffect(() => {
    if (!containerRef.current) return
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    let ptyTimer: ReturnType<typeof setTimeout> | null = null
    let lastWidth = 0
    let lastHeight = 0
    let lastFitMs = 0

    const fitNow = () => {
      if (!fitAddonRef.current || !terminalRef.current) return
      // Shown at the holder's size: this container's size changes nothing.
      if (viewSizeRef.current) return
      const started = performance.now()
      fitTerminal(fitAddonRef.current)
      lastFitMs = performance.now() - started
    }

    const flushPtyResize = () => {
      ptyTimer = null
      if (fitTimer) {
        clearTimeout(fitTimer)
        fitTimer = null
        fitNow()
      }
      if (holdsSize && !viewSizeRef.current) sendClaim(false)
    }

    const scheduleResize = () => {
      if (!fitTimer) {
        fitTimer = setTimeout(
          () => {
            fitTimer = null
            fitNow()
          },
          Math.max(FIT_DEBOUNCE_MS, lastFitMs * FIT_COST_RATIO),
        )
      }
      if (ptyTimer) clearTimeout(ptyTimer)
      ptyTimer = setTimeout(flushPtyResize, PTY_RESIZE_DEBOUNCE_MS)
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width === lastWidth && height === lastHeight) return
      lastWidth = width
      lastHeight = height
      scheduleResize()
    })

    resizeObserver.observe(containerRef.current)
    const viewportCleanup = attachViewportResizeListeners(scheduleResize)

    return () => {
      if (fitTimer) clearTimeout(fitTimer)
      if (ptyTimer) clearTimeout(ptyTimer)
      viewportCleanup()
      resizeObserver.disconnect()
    }
  }, [terminalRef, containerRef, fitAddonRef, holdsSize, sendClaim])

  return { handleResize }
}
