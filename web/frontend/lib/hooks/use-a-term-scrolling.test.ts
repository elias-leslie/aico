import { renderHook } from '@testing-library/react'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getMouseWheelTickCount,
  getWheelMouseTickCount,
} from './a-term-scrolling-utils'
import {
  getTouchScrollEffectiveCellHeight,
  getTouchScrollLineDelta,
  initializeTouchTracking,
  refreshATermViewport,
  useATermScrolling,
} from './use-a-term-scrolling'

function createTouchEvent(
  type: string,
  clientY: number,
  clientX = 0,
  touchCount = 1,
): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  })

  // touchend and touchcancel list no touch once the last finger is up.
  const active = type === 'touchend' || type === 'touchcancel' ? 0 : touchCount
  Object.defineProperty(event, 'touches', {
    value: Array.from({ length: active }, () => ({ clientX, clientY })),
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

describe('getMouseWheelTickCount', () => {
  it('sends one wheel tick per text row of drag', () => {
    expect(getMouseWheelTickCount(54, 18)).toBe(3)
    expect(getMouseWheelTickCount(-54, 18)).toBe(3)
  })

  it('holds a sub-row drag until it is worth a tick', () => {
    expect(getMouseWheelTickCount(10, 18)).toBe(0)
  })

  it('caps a fling so one event cannot flood the session', () => {
    expect(getMouseWheelTickCount(10_000, 18)).toBe(12)
  })

  it('falls back to the pixel threshold when the cell height is unknown', () => {
    expect(getMouseWheelTickCount(120, 0)).toBe(2)
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

describe('getWheelMouseTickCount', () => {
  it('converts a pixel wheel notch into rows of scroll', () => {
    expect(getWheelMouseTickCount(120, 0, 20, 30)).toBe(6)
    expect(getWheelMouseTickCount(-120, 0, 20, 30)).toBe(6)
  })

  it('falls back to a nominal row height when the pane has not been measured', () => {
    expect(getWheelMouseTickCount(120, 0, 0, 30)).toBe(9)
  })

  it('takes line and page deltas at face value', () => {
    expect(getWheelMouseTickCount(3, 1, 20, 30)).toBe(3)
    expect(getWheelMouseTickCount(1, 2, 20, 8)).toBe(8)
  })

  it('always moves at least one row and never floods the session', () => {
    expect(getWheelMouseTickCount(2, 0, 20, 30)).toBe(1)
    expect(getWheelMouseTickCount(10_000, 0, 20, 30)).toBe(12)
    expect(getWheelMouseTickCount(0, 0, 20, 30)).toBe(0)
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

  it('sends wheel reports instead of tmux copy-mode keys when the app tracks the mouse', () => {
    const aTerm = {
      buffer: { active: { type: 'alternate' } },
      modes: { mouseTrackingMode: 'any' },
      cols: 80,
      refresh: vi.fn(),
      rows: 18,
      scrollLines: vi.fn(),
    }
    const send = vi.fn()
    const wsRef = { current: { readyState: WebSocket.OPEN, send } }
    const aTermRef = { current: aTerm }
    const container = document.createElement('div')

    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: aTermRef as unknown as { current: XtermATerm | null },
        isMobile: true,
      }),
    )

    const { wheelCleanup, touchCleanup } =
      result.current.setupScrolling(container)

    container.dispatchEvent(createTouchEvent('touchstart', 260))
    container.dispatchEvent(createTouchEvent('touchmove', 320))

    // Never the tmux copy-mode prefix: that used to strand the pane in
    // copy-mode, where tmux swallows every later keystroke.
    const copyModePrefix = `${String.fromCharCode(2)}[`
    for (const [payload] of send.mock.calls) {
      expect(payload).not.toContain(copyModePrefix)
    }
    const wheelUpPrefix = `${String.fromCharCode(27)}[<64;`
    expect(
      send.mock.calls.some(
        ([payload]) =>
          typeof payload === 'string' &&
          payload.startsWith(wheelUpPrefix) &&
          payload.endsWith('M'),
      ),
    ).toBe(true)

    touchCleanup()
    wheelCleanup()
  })
})

describe('useATermScrolling touch taps', () => {
  const clickPrefix = `${String.fromCharCode(27)}[<0;`

  function setup(options: { tracking?: 'any' | 'none'; sgr?: boolean } = {}) {
    const { tracking = 'any', sgr = true } = options
    const aTerm = {
      buffer: { active: { type: 'alternate' } },
      modes: { mouseTrackingMode: tracking },
      cols: 100,
      refresh: vi.fn(),
      rows: 50,
      scrollLines: vi.fn(),
    }
    const send = vi.fn()
    const wsRef = { current: { readyState: WebSocket.OPEN, send } }
    const container = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect
    container.appendChild(screen)
    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: wsRef as never,
        aTermRef: { current: aTerm } as unknown as {
          current: XtermATerm | null
        },
        isMobile: true,
        isSgrMouse: () => sgr,
      }),
    )
    const cleanup = result.current.setupScrolling(container)
    return { container, send, cleanup }
  }

  it('reports a tap as a left click to a program that tracks the mouse', () => {
    const { container, send, cleanup } = setup()

    container.dispatchEvent(createTouchEvent('touchstart', 255, 345))
    container.dispatchEvent(createTouchEvent('touchend', 255, 345))

    // Cell (column 35, row 26): the pixel point scaled to the 100x50 grid.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      `${clickPrefix}35;26M${clickPrefix}35;26m`,
    )
    cleanup.touchCleanup()
    cleanup.wheelCleanup()
  })

  it('does not click when the finger moved (a scroll)', () => {
    const { container, send, cleanup } = setup()

    container.dispatchEvent(createTouchEvent('touchstart', 255, 345))
    container.dispatchEvent(createTouchEvent('touchmove', 300, 345))
    container.dispatchEvent(createTouchEvent('touchend', 300, 345))

    expect(
      send.mock.calls.some(([payload]) => payload.startsWith(clickPrefix)),
    ).toBe(false)
    cleanup.touchCleanup()
    cleanup.wheelCleanup()
  })

  it('does not click after a long press', () => {
    vi.useFakeTimers()
    const { container, send, cleanup } = setup()

    container.dispatchEvent(createTouchEvent('touchstart', 255, 345))
    vi.advanceTimersByTime(600)
    container.dispatchEvent(createTouchEvent('touchend', 255, 345))

    expect(send).not.toHaveBeenCalled()
    cleanup.touchCleanup()
    cleanup.wheelCleanup()
  })

  it('does not click for a second finger, a cancelled touch, or a program that ignores the mouse', () => {
    const multi = setup()
    multi.container.dispatchEvent(createTouchEvent('touchstart', 255, 345, 2))
    multi.container.dispatchEvent(createTouchEvent('touchend', 255, 345))
    expect(multi.send).not.toHaveBeenCalled()

    const cancelled = setup()
    cancelled.container.dispatchEvent(createTouchEvent('touchstart', 255, 345))
    cancelled.container.dispatchEvent(createTouchEvent('touchcancel', 255, 345))
    cancelled.container.dispatchEvent(createTouchEvent('touchend', 255, 345))
    expect(cancelled.send).not.toHaveBeenCalled()

    const plain = setup({ tracking: 'none' })
    plain.container.dispatchEvent(createTouchEvent('touchstart', 255, 345))
    plain.container.dispatchEvent(createTouchEvent('touchend', 255, 345))
    expect(plain.send).not.toHaveBeenCalled()

    const notSgr = setup({ sgr: false })
    notSgr.container.dispatchEvent(createTouchEvent('touchstart', 255, 345))
    notSgr.container.dispatchEvent(createTouchEvent('touchend', 255, 345))
    expect(notSgr.send).not.toHaveBeenCalled()

    for (const run of [multi, cancelled, plain, notSgr]) {
      run.cleanup.touchCleanup()
      run.cleanup.wheelCleanup()
    }
  })
})

describe('useATermScrolling wheel routing', () => {
  function setup(
    screen: 'normal' | 'alternate',
    mouseTrackingMode: string,
    sgr: boolean,
  ) {
    const aTerm = {
      buffer: { active: { type: screen } },
      cols: 80,
      modes: { mouseTrackingMode },
      refresh: vi.fn(),
      rows: 30,
      scrollLines: vi.fn(),
    }
    const send = vi.fn()
    const container = document.createElement('div')
    const { result } = renderHook(() =>
      useATermScrolling({
        wsRef: { current: { readyState: WebSocket.OPEN, send } } as never,
        aTermRef: { current: aTerm } as unknown as {
          current: XtermATerm | null
        },
        isMobile: false,
        isSgrMouse: () => sgr,
      }),
    )
    const { wheelCleanup } = result.current.setupScrolling(container)
    const event = new WheelEvent('wheel', {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    })
    container.dispatchEvent(event)
    wheelCleanup()
    return { aTerm, send, event }
  }

  it('scrolls xterm history 14 lines a notch', () => {
    const { aTerm, send, event } = setup('normal', 'none', false)
    expect(aTerm.scrollLines).toHaveBeenCalledWith(-14)
    expect(send).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('sends SGR wheel reports to a program that reads SGR', () => {
    const { aTerm, send } = setup('alternate', 'any', true)
    expect(send).toHaveBeenCalled()
    expect(send.mock.calls[0][0].startsWith('\x1b[<64;')).toBe(true)
    expect(aTerm.scrollLines).not.toHaveBeenCalled()
  })

  it('leaves a non-SGR mouse report to xterm', () => {
    const { send, event } = setup('alternate', 'vt200', false)
    expect(send).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('consumes the wheel on a full-screen program without mouse tracking', () => {
    const { aTerm, send, event } = setup('alternate', 'none', false)
    expect(send).not.toHaveBeenCalled()
    expect(aTerm.scrollLines).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })
})
