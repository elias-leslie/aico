import type { FitAddon } from '@xterm/addon-fit'
import { useCallback, useEffect } from 'react'
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
 * keeps up with window drags, but the backend (PTY) resize message only fires
 * on the trailing edge — SIGWINCH mid-drag causes shells with fancy prompts and
 * heavy TUIs (Claude Code, Codex CLI) to redraw repeatedly, which the user
 * perceives as flicker and slow resize. The shell only cares about the final size.
 */
export function useATermResize(options: ATermResizeOptions) {
  const {
    aTermRef,
    fitAddonRef,
    containerRef,
    wsRef,
    sendBackendResize = true,
  } = options

  const sendBackendResizeIfChanged = useCallback(
    (lastSent: { cols: number; rows: number }): void => {
      if (!sendBackendResize) return
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      const dims = fitAddonRef.current?.proposeDimensions()
      if (!dims) return
      if (dims.cols === lastSent.cols && dims.rows === lastSent.rows) return
      lastSent.cols = dims.cols
      lastSent.rows = dims.rows
      wsRef.current.send(
        JSON.stringify({
          __ctrl: true,
          resize: { cols: dims.cols, rows: dims.rows },
        }),
      )
    },
    [fitAddonRef, sendBackendResize, wsRef],
  )

  // Imperative resize used on visibility/status changes — fits and signals
  // the backend immediately; not part of the drag debounce flow.
  const handleResize = useCallback(() => {
    if (!fitAddonRef.current || !aTermRef.current) return
    fitAddonRef.current.fit()
    if (sendBackendResize && wsRef.current?.readyState === WebSocket.OPEN) {
      const dims = fitAddonRef.current.proposeDimensions()
      if (dims) {
        wsRef.current.send(
          JSON.stringify({
            __ctrl: true,
            resize: { cols: dims.cols, rows: dims.rows },
          }),
        )
      }
    }
  }, [aTermRef, fitAddonRef, sendBackendResize, wsRef])

  useEffect(() => {
    if (!containerRef.current) return
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    let ptyTimer: ReturnType<typeof setTimeout> | null = null
    let lastWidth = 0
    let lastHeight = 0
    const lastSent = { cols: 0, rows: 0 }

    const flushPtyResize = () => {
      ptyTimer = null
      sendBackendResizeIfChanged(lastSent)
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
  }, [aTermRef, containerRef, fitAddonRef, sendBackendResizeIfChanged])

  return { handleResize }
}
