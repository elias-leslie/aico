import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachViewportResizeListeners,
  useATermResize,
} from './use-a-term-resize'

describe('attachViewportResizeListeners', () => {
  const originalVisualViewport = window.visualViewport

  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    })
  })

  it('listens to both window and visual viewport changes', () => {
    const callback = vi.fn()
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        addEventListener,
        removeEventListener,
      },
    })

    const cleanup = attachViewportResizeListeners(callback)

    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('orientationchange'))

    expect(callback).toHaveBeenCalledTimes(2)
    expect(addEventListener).toHaveBeenCalledWith('resize', callback, {
      passive: true,
    })
    expect(addEventListener).toHaveBeenCalledWith('scroll', callback, {
      passive: true,
    })

    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')

    cleanup()

    expect(windowRemoveSpy).toHaveBeenCalledWith('resize', callback)
    expect(windowRemoveSpy).toHaveBeenCalledWith('orientationchange', callback)
    expect(removeEventListener).toHaveBeenCalledWith('resize', callback)
    expect(removeEventListener).toHaveBeenCalledWith('scroll', callback)

    windowRemoveSpy.mockRestore()
  })

  it('gracefully handles browsers without visual viewport support', () => {
    const callback = vi.fn()

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    })

    const cleanup = attachViewportResizeListeners(callback)

    window.dispatchEvent(new Event('resize'))

    expect(callback).toHaveBeenCalledTimes(1)

    cleanup()
  })
})

describe('useATermResize shared-size claim', () => {
  const originalResizeObserver = globalThis.ResizeObserver

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
    vi.useRealTimers()
  })

  function setup(sendBackendResize = true) {
    let observerCallback: ResizeObserverCallback | null = null
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    let dims = { cols: 80, rows: 24 }
    const send = vi.fn()
    const options = {
      aTermRef: { current: {} as never },
      fitAddonRef: {
        current: { fit: vi.fn(), proposeDimensions: () => dims } as never,
      },
      containerRef: { current: document.createElement('div') },
      wsRef: { current: { readyState: WebSocket.OPEN, send } as never },
      sendBackendResize,
    }
    const { result } = renderHook(() => useATermResize(options))
    const observe = (width: number, height: number, next: typeof dims) => {
      dims = next
      observerCallback?.(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        {} as ResizeObserver,
      )
    }
    const messages = () =>
      send.mock.calls.map(([raw]) => JSON.parse(raw as string))
    return { result, observe, messages }
  }

  it('claims the shared size only when the view becomes active', () => {
    vi.useFakeTimers()
    const { result, observe, messages } = setup()

    result.current.handleResize()
    expect(messages()).toEqual([
      { __ctrl: true, resize: { cols: 80, rows: 24 }, claim: true },
    ])

    observe(800, 600, { cols: 100, rows: 30 })
    vi.advanceTimersByTime(1000)
    observe(900, 700, { cols: 120, rows: 40 })
    vi.advanceTimersByTime(1000)

    expect(messages().slice(1)).toEqual([
      { __ctrl: true, resize: { cols: 100, rows: 30 } },
      { __ctrl: true, resize: { cols: 120, rows: 40 } },
    ])
  })

  it('sends nothing while another view owns the size', () => {
    vi.useFakeTimers()
    const { result, observe, messages } = setup(false)

    result.current.handleResize()
    observe(800, 600, { cols: 100, rows: 30 })
    vi.advanceTimersByTime(1000)

    expect(messages()).toEqual([])
  })
})
