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
  sendBackendResize?: boolean
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
 * Only the active view (visible, focused, connected: `sendBackendResize`)
 * sends anything, and every size it sends is also a claim on the shared tmux
 * window. The view's own container changes size without the view changing
 * activity (phone accessory bar or keyboard, address-bar collapse, rotation,
 * desktop drag); if those only resized this view's PTY client, tmux would keep
 * the older claimed window size and fill the difference with its dot pattern.
 * Identical sizes are deduped. Inactive views never claim.
 */
export function useTerminalResize(options: TerminalResizeOptions) {
  const {
    terminalRef,
    fitAddonRef,
    containerRef,
    wsRef,
    sendBackendResize = true,
  } = options
  // Last size this view claimed on the current socket. A new socket or a new
  // activation always claims again (see handleResize).
  const lastClaimRef = useRef<{
    ws: WebSocket | null
    cols: number
    rows: number
  }>({ ws: null, cols: 0, rows: 0 })

  const sendClaim = useCallback(
    (force: boolean): void => {
      if (!sendBackendResize) return
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
    [fitAddonRef, sendBackendResize, wsRef],
  )

  // Imperative resize used when the view becomes active (visible, focused and
  // connected): fit and claim the shared tmux window size for this view, even
  // if the size equals the last claim (another client may have claimed since).
  const handleResize = useCallback(() => {
    if (!fitAddonRef.current || !terminalRef.current) return
    if (!fitTerminal(fitAddonRef.current)) return
    sendClaim(true)
  }, [terminalRef, fitAddonRef, sendClaim])

  // Claim again once the layout has settled (the view became active): a window
  // that regains focus is usually mid-resize (the focus event can arrive
  // before the resize that caused it, and an immediate fit would claim the
  // old size, then the new one 150 ms later, redrawing the program twice).
  const scheduleRef = useRef<(() => void) | null>(null)
  const forceClaimRef = useRef(false)
  const requestClaim = useCallback(() => {
    forceClaimRef.current = true
    scheduleRef.current?.()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    let ptyTimer: ReturnType<typeof setTimeout> | null = null
    let lastWidth = 0
    let lastHeight = 0
    let lastFitMs = 0

    const fitNow = () => {
      if (!fitAddonRef.current || !terminalRef.current) return
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
      const force = forceClaimRef.current
      forceClaimRef.current = false
      sendClaim(force)
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

    scheduleRef.current = scheduleResize
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
      scheduleRef.current = null
      if (fitTimer) clearTimeout(fitTimer)
      if (ptyTimer) clearTimeout(ptyTimer)
      viewportCleanup()
      resizeObserver.disconnect()
    }
  }, [terminalRef, containerRef, fitAddonRef, sendClaim])

  return { handleResize, requestClaim }
}
