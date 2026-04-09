import { renderHook } from '@testing-library/react'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTouchScrollEffectiveCellHeight,
  getTouchScrollLineDelta,
  initializeTouchTracking,
  refreshATermViewport,
  useATermScrolling,
} from './use-a-term-scrolling'

function createTouchEvent(type: string, clientY: number): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  })

  Object.defineProperty(event, 'touches', {
    value: [{ clientY }],
    configurable: true,
  })

  return event
}

afterEach(() => {
  vi.useRealTimers()
})

describe('getTouchScrollLineDelta', () => {
  it('uses natural touch direction when the finger moves upward', () => {
    expect(getTouchScrollLineDelta(36, 18)).toBe(8)
  })

  it('uses natural touch direction when the finger moves downward', () => {
    expect(getTouchScrollLineDelta(-27, 18)).toBe(-6)
  })

  it('returns zero when there is not enough information to compute a scroll', () => {
    expect(getTouchScrollLineDelta(0, 18)).toBe(0)
    expect(getTouchScrollLineDelta(20, 0)).toBe(0)
  })
})

describe('getTouchScrollEffectiveCellHeight', () => {
  it('halves the current touch step size so scrolling is twice as fast', () => {
    expect(getTouchScrollEffectiveCellHeight(18)).toBe(4.5)
  })

  it('returns zero for invalid cell heights', () => {
    expect(getTouchScrollEffectiveCellHeight(0)).toBe(0)
  })
})

describe('refreshATermViewport', () => {
  it('uses the public xterm refresh API', () => {
    const refresh = vi.fn()

    refreshATermViewport({
      rows: 18,
      refresh,
    } as unknown as Parameters<typeof refreshATermViewport>[0])

    expect(refresh).toHaveBeenCalledWith(0, 17)
  })
})

describe('initializeTouchTracking', () => {
  it('boots touch tracking from the first observed move position', () => {
    expect(initializeTouchTracking(144)).toEqual({
      touchStartY: 144,
      lastSentY: 144,
    })
  })
})

describe('useATermScrolling', () => {
  it('routes desktop wheel scrolling through xterm scrollLines on normal screen', () => {
    const aTerm = {
      buffer: { active: { type: 'normal' } },
      modes: { mouseTrackingMode: 'none' },
      refresh: vi.fn(),
      rows: 18,
      scrollLines: vi.fn(),
    }
    const wsRef = {
      current: { readyState: WebSocket.OPEN, send: vi.fn() },
    }
    const aTermRef = { current: aTerm }
    const container = document.createElement('div')
    const downstreamListener = vi.fn()
    container.addEventListener('wheel', downstreamListener)

    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: aTermRef as unknown as { current: XtermATerm | null },
        isMobile: false,
        sessionMode: 'shell',
      }),
    )

    const { wheelCleanup } = result.current.setupScrolling(container)
    const event = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    })

    container.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(aTerm.scrollLines).toHaveBeenCalledWith(10)
    expect(aTerm.refresh).toHaveBeenCalledWith(0, 17)
    expect(downstreamListener).not.toHaveBeenCalled()

    wheelCleanup()
  })

  it('does not intercept alternate-screen wheel events for shell sessions', () => {
    const aTerm = {
      buffer: { active: { type: 'alternate' } },
      modes: { mouseTrackingMode: 'none' },
      refresh: vi.fn(),
      rows: 18,
      scrollLines: vi.fn(),
    }
    const wsRef = {
      current: { readyState: WebSocket.OPEN, send: vi.fn() },
    }
    const aTermRef = { current: aTerm }
    const container = document.createElement('div')
    const downstreamListener = vi.fn()
    container.addEventListener('wheel', downstreamListener)

    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: aTermRef as unknown as { current: XtermATerm | null },
        isMobile: false,
        sessionMode: 'shell',
      }),
    )

    const { wheelCleanup } = result.current.setupScrolling(container)
    const event = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    })

    container.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(aTerm.scrollLines).not.toHaveBeenCalled()
    expect(downstreamListener).toHaveBeenCalledTimes(1)

    wheelCleanup()
  })

  it('opens scrollback overlay for non-shell alternate-screen upward wheel events', () => {
    const aTerm = {
      buffer: { active: { type: 'alternate' } },
      modes: { mouseTrackingMode: 'none' },
      refresh: vi.fn(),
      rows: 18,
      scrollLines: vi.fn(),
    }
    const requestOverlay = vi.fn()
    const wsRef = {
      current: { readyState: WebSocket.OPEN, send: vi.fn() },
    }
    const aTermRef = { current: aTerm }
    const container = document.createElement('div')
    const downstreamListener = vi.fn()
    container.addEventListener('wheel', downstreamListener)

    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: aTermRef as unknown as { current: XtermATerm | null },
        isMobile: false,
        sessionMode: 'claude',
        onRequestScrollbackOverlay: requestOverlay,
        isScrollbackOverlayActive: false,
      }),
    )

    const { wheelCleanup } = result.current.setupScrolling(container)
    const event = new WheelEvent('wheel', {
      deltaY: -80,
      bubbles: true,
      cancelable: true,
    })

    container.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(requestOverlay).toHaveBeenCalledWith(-10)
    expect(aTerm.scrollLines).not.toHaveBeenCalled()
    expect(aTerm.refresh).not.toHaveBeenCalled()
    expect(downstreamListener).not.toHaveBeenCalled()

    wheelCleanup()
  })

  it('suppresses local wheel scrolling for non-shell alternate-screen downward wheel events', () => {
    const aTerm = {
      buffer: { active: { type: 'alternate' } },
      modes: { mouseTrackingMode: 'none' },
      refresh: vi.fn(),
      rows: 18,
      scrollLines: vi.fn(),
    }
    const requestOverlay = vi.fn()
    const wsRef = {
      current: { readyState: WebSocket.OPEN, send: vi.fn() },
    }
    const aTermRef = { current: aTerm }
    const container = document.createElement('div')
    const downstreamListener = vi.fn()
    container.addEventListener('wheel', downstreamListener)

    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: aTermRef as unknown as { current: XtermATerm | null },
        isMobile: false,
        sessionMode: 'claude',
        onRequestScrollbackOverlay: requestOverlay,
        isScrollbackOverlayActive: false,
      }),
    )

    const { wheelCleanup } = result.current.setupScrolling(container)
    const event = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    })

    container.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(requestOverlay).not.toHaveBeenCalled()
    expect(aTerm.scrollLines).not.toHaveBeenCalled()
    expect(aTerm.refresh).not.toHaveBeenCalled()
    expect(downstreamListener).not.toHaveBeenCalled()

    wheelCleanup()
  })

  it('opens scrollback overlay for non-shell downward touch drags on mobile', () => {
    const aTerm = {
      buffer: { active: { type: 'alternate' } },
      modes: { mouseTrackingMode: 'none' },
      refresh: vi.fn(),
      rows: 18,
      scrollLines: vi.fn(),
    }
    const requestOverlay = vi.fn()
    const wsRef = {
      current: { readyState: WebSocket.OPEN, send: vi.fn() },
    }
    const aTermRef = { current: aTerm }
    const container = document.createElement('div')

    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: aTermRef as unknown as { current: XtermATerm | null },
        isMobile: true,
        sessionMode: 'claude',
        onRequestScrollbackOverlay: requestOverlay,
        isScrollbackOverlayActive: false,
      }),
    )

    const { wheelCleanup, touchCleanup } =
      result.current.setupScrolling(container)

    container.dispatchEvent(createTouchEvent('touchstart', 200))
    container.dispatchEvent(createTouchEvent('touchmove', 260))

    expect(requestOverlay).toHaveBeenCalledTimes(1)
    expect(aTerm.scrollLines).not.toHaveBeenCalled()

    touchCleanup()
    wheelCleanup()
  })

  it('does not open scrollback overlay for non-shell upward touch drags on mobile', () => {
    const aTerm = {
      buffer: { active: { type: 'alternate' } },
      modes: { mouseTrackingMode: 'none' },
      refresh: vi.fn(),
      rows: 18,
      scrollLines: vi.fn(),
    }
    const requestOverlay = vi.fn()
    const wsRef = {
      current: { readyState: WebSocket.OPEN, send: vi.fn() },
    }
    const aTermRef = { current: aTerm }
    const container = document.createElement('div')

    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: aTermRef as unknown as { current: XtermATerm | null },
        isMobile: true,
        sessionMode: 'claude',
        onRequestScrollbackOverlay: requestOverlay,
        isScrollbackOverlayActive: false,
      }),
    )

    const { wheelCleanup, touchCleanup } =
      result.current.setupScrolling(container)

    container.dispatchEvent(createTouchEvent('touchstart', 260))
    container.dispatchEvent(createTouchEvent('touchmove', 200))

    expect(requestOverlay).not.toHaveBeenCalled()
    expect(aTerm.scrollLines).not.toHaveBeenCalled()

    touchCleanup()
    wheelCleanup()
  })

  it('exposes resetCopyMode for clearing tmux copy-mode state', () => {
    const aTerm = {
      buffer: { active: { type: 'normal' } },
      modes: { mouseTrackingMode: 'none' },
      refresh: vi.fn(),
      rows: 18,
      scrollLines: vi.fn(),
    }
    const wsRef = {
      current: { readyState: WebSocket.OPEN, send: vi.fn() },
    }
    const aTermRef = { current: aTerm }

    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: aTermRef as unknown as { current: XtermATerm | null },
        isMobile: false,
        sessionMode: 'shell',
      }),
    )

    expect(() => result.current.resetCopyMode()).not.toThrow()
  })
})
