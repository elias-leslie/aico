import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachViewportResizeListeners } from './use-aterm-resize'

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
