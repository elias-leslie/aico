import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMinSizeCalculator } from './use-min-size-calculator'

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0]

class ResizeObserverMock {
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  disconnect() {}

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }

  unobserve() {}
}

function createContainerRef(width: number, height: number) {
  const element = document.createElement('div')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })

  return { current: element } as React.RefObject<HTMLDivElement>
}

describe('useMinSizeCalculator', () => {
  const originalResizeObserver = globalThis.ResizeObserver

  beforeEach(() => {
    globalThis.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
  })

  it('caps two-pane minimum sizes below an equal split', async () => {
    const containerRef = createContainerRef(800, 600)

    const { result } = renderHook(() => useMinSizeCalculator(containerRef))

    await waitFor(() => {
      expect(result.current('horizontal', 2)).toBe(45)
    })

    expect(result.current('vertical', 2)).toBe(45)
  })

  it('keeps preferred pixel minimums when the group has headroom', async () => {
    const containerRef = createContainerRef(1600, 1000)

    const { result } = renderHook(() => useMinSizeCalculator(containerRef))

    await waitFor(() => {
      expect(result.current('horizontal', 2)).toBe(25)
    })

    expect(result.current('vertical', 2)).toBe(30)
  })
})
