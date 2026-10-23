import { describe, expect, it, vi } from 'vitest'
import {
  installBootstrapWheelBlocker,
  replaceScrollingHandlers,
} from './use-a-term-instance'

describe('installBootstrapWheelBlocker', () => {
  it('blocks wheel events until scrolling handlers are ready', () => {
    const container = document.createElement('div')
    const child = document.createElement('div')
    container.appendChild(child)

    const cleanup = installBootstrapWheelBlocker(container)

    // Listen on the child so stopPropagation (not stopImmediatePropagation)
    // is sufficient — avoids jsdom ordering quirks for same-element listeners.
    const downstreamListener = vi.fn()
    child.addEventListener('wheel', downstreamListener)

    const blockedEvent = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    })

    child.dispatchEvent(blockedEvent)

    expect(blockedEvent.defaultPrevented).toBe(true)
    expect(downstreamListener).not.toHaveBeenCalled()

    cleanup()

    const unblockedEvent = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    })

    child.dispatchEvent(unblockedEvent)

    expect(unblockedEvent.defaultPrevented).toBe(false)
    expect(downstreamListener).toHaveBeenCalledTimes(1)
  })
})

describe('replaceScrollingHandlers', () => {
  it('removes the previous wheel handlers before installing replacement handlers', () => {
    const container = document.createElement('div')
    const previousWheelListener = vi.fn()
    const nextWheelListener = vi.fn()
    container.addEventListener('wheel', previousWheelListener)

    const currentCleanup = {
      wheelCleanup: vi.fn(() => {
        container.removeEventListener('wheel', previousWheelListener)
      }),
      touchCleanup: vi.fn(),
    }
    const setupScrolling = vi.fn(() => {
      container.addEventListener('wheel', nextWheelListener)
      return {
        wheelCleanup: vi.fn(() => {
          container.removeEventListener('wheel', nextWheelListener)
        }),
        touchCleanup: vi.fn(),
      }
    })

    const nextCleanup = replaceScrollingHandlers(
      container,
      setupScrolling,
      currentCleanup,
    )

    const event = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    })
    container.dispatchEvent(event)

    expect(currentCleanup.wheelCleanup).toHaveBeenCalledTimes(1)
    expect(currentCleanup.touchCleanup).toHaveBeenCalledTimes(1)
    expect(setupScrolling).toHaveBeenCalledWith(container)
    expect(previousWheelListener).not.toHaveBeenCalled()
    expect(nextWheelListener).toHaveBeenCalledTimes(1)
    expect(nextCleanup.wheelCleanup).toBeTypeOf('function')
    expect(nextCleanup.touchCleanup).toBeTypeOf('function')
  })
})
