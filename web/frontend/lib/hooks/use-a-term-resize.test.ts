import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIT_DEBOUNCE_MS, PTY_RESIZE_DEBOUNCE_MS } from '../constants/a-term'
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

  it('re-claims the shared size whenever the active view refits', () => {
    vi.useFakeTimers()
    const { result, observe, messages } = setup()

    result.current.handleResize()
    expect(messages()).toEqual([
      { __ctrl: true, resize: { cols: 80, rows: 24 }, claim: true },
    ])

    // Accessory bar / keyboard / rotation: the container changes while the
    // view stays active. Each settled size must claim again, or tmux keeps the
    // older manual window size and draws its dot fill under the client.
    observe(800, 600, { cols: 100, rows: 30 })
    vi.advanceTimersByTime(1000)
    observe(900, 700, { cols: 120, rows: 40 })
    vi.advanceTimersByTime(1000)

    expect(messages().slice(1)).toEqual([
      { __ctrl: true, resize: { cols: 100, rows: 30 }, claim: true },
      { __ctrl: true, resize: { cols: 120, rows: 40 }, claim: true },
    ])
  })

  it('debounces a burst of layout changes into one claim of the settled size', () => {
    vi.useFakeTimers()
    const { observe, messages } = setup()

    observe(400, 900, { cols: 46, rows: 44 })
    vi.advanceTimersByTime(50)
    observe(400, 860, { cols: 46, rows: 41 })
    vi.advanceTimersByTime(50)
    observe(400, 880, { cols: 46, rows: 40 })
    vi.advanceTimersByTime(PTY_RESIZE_DEBOUNCE_MS + FIT_DEBOUNCE_MS)

    expect(messages()).toEqual([
      { __ctrl: true, resize: { cols: 46, rows: 40 }, claim: true },
    ])
  })

  it('dedupes pixel changes that do not change the fitted grid', () => {
    vi.useFakeTimers()
    const { result, observe, messages } = setup()

    result.current.handleResize()
    observe(801, 600, { cols: 80, rows: 24 })
    vi.advanceTimersByTime(1000)
    observe(802, 603, { cols: 80, rows: 24 })
    vi.advanceTimersByTime(1000)

    expect(messages()).toHaveLength(1)
  })

  it('claims again on activation even when the size is unchanged', () => {
    vi.useFakeTimers()
    const { result, messages } = setup()

    result.current.handleResize()
    result.current.handleResize()

    expect(messages()).toHaveLength(2)
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
