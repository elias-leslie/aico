import { useCallback, useEffect } from 'react'
import type { FitAddon } from '@xterm/addon-fit'
import { RESIZE_DEBOUNCE_MS } from '../constants/a-term'

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
  window.addEventListener('orientationchange', onViewportChange, { passive: true })

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
 * Handles container size changes and sends resize events to backend when connected.
 */
export function useATermResize(options: ATermResizeOptions) {
  const {
    aTermRef,
    fitAddonRef,
    containerRef,
    wsRef,
    sendBackendResize = true,
  } = options

  // Handle resize - always fit the aTerm, send dims only if WS connected
  const handleResize = useCallback(() => {
    if (fitAddonRef.current && aTermRef.current) {
      fitAddonRef.current.fit()

      // Only send resize to backend if WS is connected
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
    }
  }, [fitAddonRef, sendBackendResize, aTermRef, wsRef])

  // Handle container resize with debounce
  useEffect(() => {
    if (!containerRef.current) return
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null
    let lastWidth = 0
    let lastHeight = 0
    const scheduleResize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout)
      resizeTimeout = setTimeout(() => handleResize(), RESIZE_DEBOUNCE_MS)
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
      if (resizeTimeout) clearTimeout(resizeTimeout)
      viewportCleanup()
      resizeObserver.disconnect()
    }
  }, [containerRef, handleResize])

  return { handleResize }
}
