import type { FitAddon } from '@xterm/addon-fit'
import { useCallback, useEffect, useRef } from 'react'
import { FIT_DEBOUNCE_MS, PTY_RESIZE_DEBOUNCE_MS } from '../constants/a-term'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

export interface ATermResizeOptions {
  aTermRef: React.MutableRefObject<XtermATerm | null>
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
 * Hook to manage aTerm resizing with ResizeObserver and WebSocket dimension updates.
 *
 * Two-stage debounce: the local xterm fit runs on a short debounce so the visual
 * keeps up with window drags, but the backend message only fires on the
 * trailing edge — SIGWINCH mid-drag causes shells with fancy prompts and heavy
 * TUIs (Claude Code, Codex CLI) to redraw repeatedly, which the user perceives
 * as flicker and slow resize. The shell only cares about the final size.
 *
 * Only the active view (visible, focused, connected: `sendBackendResize`)
 * sends anything, and every size it sends is also a claim on the shared tmux
 * window. The view's own container changes size without the view changing
 * activity (phone accessory bar or keyboard, address-bar collapse, rotation,
 * desktop drag); if those only resized this view's PTY client, tmux would keep
 * the older claimed window size and fill the difference with its dot pattern.
 * Identical sizes are deduped. Inactive views never claim.
 */
export function useATermResize(options: ATermResizeOptions) {
  const {
    aTermRef,
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
      const dims = fitAddonRef.current?.proposeDimensions()
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
    if (!fitAddonRef.current || !aTermRef.current) return
    fitAddonRef.current.fit()
    sendClaim(true)
  }, [aTermRef, fitAddonRef, sendClaim])

  useEffect(() => {
    if (!containerRef.current) return
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    let ptyTimer: ReturnType<typeof setTimeout> | null = null
    let lastWidth = 0
    let lastHeight = 0

    const flushPtyResize = () => {
      ptyTimer = null
      sendClaim(false)
    }

    const scheduleResize = () => {
      if (fitTimer) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        fitTimer = null
        if (fitAddonRef.current && aTermRef.current) {
          fitAddonRef.current.fit()
        }
        if (ptyTimer) clearTimeout(ptyTimer)
        ptyTimer = setTimeout(flushPtyResize, PTY_RESIZE_DEBOUNCE_MS)
      }, FIT_DEBOUNCE_MS)
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
  }, [aTermRef, containerRef, fitAddonRef, sendClaim])

  return { handleResize }
}
