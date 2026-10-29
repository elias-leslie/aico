import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIT_DEBOUNCE_MS, PTY_RESIZE_DEBOUNCE_MS } from '../constants/terminal'
import {
  attachViewportResizeListeners,
  useTerminalResize,
} from './use-terminal-resize'

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

describe('useTerminalResize shared-size claim', () => {
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
    const fit = vi.fn()
    const options = {
      terminalRef: { current: {} as never },
      fitAddonRef: {
        current: { fit, proposeDimensions: () => dims } as never,
      },
      containerRef: { current: document.createElement('div') },
      wsRef: { current: { readyState: WebSocket.OPEN, send } as never },
      sendBackendResize,
    }
    const { result } = renderHook(() => useTerminalResize(options))
    const observe = (width: number, height: number, next: typeof dims) => {
      dims = next
      observerCallback?.(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        {} as ResizeObserver,
      )
    }
    const messages = () =>
      send.mock.calls.map(([raw]) => JSON.parse(raw as string))
    return { result, observe, messages, fit }
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

  it('neither fits nor claims a container too small to be a terminal', () => {
    vi.useFakeTimers()
    const { result, observe, messages, fit } = setup()

    // A layout in transit (window mid-resize, container not laid out): fitting
    // it reflows the whole scrollback into a few columns and the program
    // redraws its transcript at that width.
    observe(30, 600, { cols: 4, rows: 35 })
    vi.advanceTimersByTime(1000)
    result.current.handleResize()
    expect(fit).not.toHaveBeenCalled()
    expect(messages()).toEqual([])

    observe(900, 700, { cols: 120, rows: 40 })
    vi.advanceTimersByTime(1000)
    expect(fit).toHaveBeenCalledTimes(1)
    expect(messages()).toEqual([
      { __ctrl: true, resize: { cols: 120, rows: 40 }, claim: true },
    ])
  })

  it('keeps refits to a fraction of the time while the window keeps changing, and settles on the last size', () => {
    vi.useFakeTimers()
    // Each fit "costs" 100 ms (a reflow of a long scrollback).
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 100
      return clock
    })
    const { observe, messages, fit } = setup()

    // A tiling extension or drag changing the size every 5 ms for 2 s.
    for (let t = 0; t < 2000; t += 5) {
      observe(800 + t, 600, { cols: 60 + (t % 40), rows: 30 })
      vi.advanceTimersByTime(5)
    }
    const duringStorm = fit.mock.calls.length
    // 100 ms per fit, FIT_COST_RATIO x that between fits: about 2000/300 fits,
    // against 2000/16 = 125 with a fixed debounce.
    expect(duringStorm).toBeLessThanOrEqual(8)
    expect(messages()).toEqual([])

    vi.advanceTimersByTime(PTY_RESIZE_DEBOUNCE_MS + 1000)
    // Exactly one claim, of the size the window ended at.
    expect(messages()).toEqual([
      {
        __ctrl: true,
        resize: { cols: 60 + (1995 % 40), rows: 30 },
        claim: true,
      },
    ])
    now.mockRestore()
  })

  it('claims on activation only after the layout settles, so a resize that follows is not preceded by a stale claim', () => {
    vi.useFakeTimers()
    const { result, observe, messages } = setup()

    // The window regained focus; its resize arrives a few ms later.
    result.current.requestClaim()
    expect(messages()).toEqual([])
    vi.advanceTimersByTime(3)
    observe(600, 700, { cols: 107, rows: 64 })
    vi.advanceTimersByTime(PTY_RESIZE_DEBOUNCE_MS + 1000)

    expect(messages()).toEqual([
      { __ctrl: true, resize: { cols: 107, rows: 64 }, claim: true },
    ])
  })

  it('still claims on activation when the size did not change', () => {
    vi.useFakeTimers()
    const { result, messages } = setup()

    result.current.handleResize()
    result.current.requestClaim()
    vi.advanceTimersByTime(PTY_RESIZE_DEBOUNCE_MS + 1000)

    expect(messages()).toHaveLength(2)
  })
})
