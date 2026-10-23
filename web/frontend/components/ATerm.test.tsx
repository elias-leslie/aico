import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATermComponent, sizeHolderName } from './ATerm'

type ATermHookOptions = Parameters<
  typeof import('../lib/hooks/use-a-term-websocket')['useATermWebSocket']
>[0]

const websocketState: {
  options: ATermHookOptions | null
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  sendInput: ReturnType<typeof vi.fn>
  wsRefCurrent: { readyState: number; send: ReturnType<typeof vi.fn> } | null
  connectCalls: number
  disconnectCalls: number
} = {
  options: null,
  connect: vi.fn(() => {
    websocketState.connectCalls += 1
  }),
  disconnect: vi.fn(() => {
    websocketState.disconnectCalls += 1
  }),
  sendInput: vi.fn(),
  wsRefCurrent: null,
  connectCalls: 0,
  disconnectCalls: 0,
}

const fakeFitAddon = {
  proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
}

const operationCallbacks: Array<() => void> = []
let aTermInstanceOptions:
  | Parameters<
      typeof import('../lib/hooks/use-a-term-instance')['useATermInstance']
    >[0]
  | null = null
let aTermInstanceReady = true
const resizeHandle = vi.fn()
let resizeHookOptions:
  | Parameters<
      typeof import('../lib/hooks/use-a-term-resize')['useATermResize']
    >[0]
  | null = null

const fakeATerm = {
  rows: 24,
  buffer: {
    active: {
      baseY: 100,
      viewportY: 100,
      cursorY: 0,
      type: 'normal' as 'normal' | 'alternate',
      getLine: vi.fn((): { translateToString: () => string } => ({
        translateToString: () => 'user@host:~$ ',
      })),
    },
  },
  parser: {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
    registerDcsHandler: vi.fn(() => ({ dispose: vi.fn() })),
    registerEscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
  },
  options: { scrollback: 0 },
  reset: vi.fn(),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  onResize: vi.fn(() => ({ dispose: vi.fn() })),
  registerMarker: vi.fn(() => ({ line: 0, dispose: vi.fn() })),
  onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
  cols: 80,
  scrollToLine: vi.fn(),
  write: vi.fn((_data: string, callback?: () => void) => {
    if (callback) {
      operationCallbacks.push(callback)
    }
  }),
  dispose: vi.fn(),
}

vi.mock('../lib/hooks/use-a-term-websocket', () => ({
  useATermWebSocket: (options: ATermHookOptions) => {
    websocketState.options = options
    return {
      status: 'connected',
      wsRef: { current: websocketState.wsRefCurrent },
      reconnect: vi.fn(),
      sendInput: websocketState.sendInput,
      connect: websocketState.connect,
      disconnect: websocketState.disconnect,
    }
  },
}))

vi.mock('../lib/hooks/use-a-term-instance', () => ({
  useATermInstance: (
    options: unknown,
    refs: {
      aTermRef: { current: typeof fakeATerm | null }
      fitAddonRef: { current: typeof fakeFitAddon | null }
      isFocusedRef: { current: boolean }
    },
  ) => {
    aTermInstanceOptions = options as Parameters<
      typeof import('../lib/hooks/use-a-term-instance')['useATermInstance']
    >[0]
    refs.aTermRef.current = fakeATerm
    refs.fitAddonRef.current = fakeFitAddon
    refs.isFocusedRef.current = true
    return { isReady: aTermInstanceReady }
  },
}))

vi.mock('../lib/hooks/use-a-term-resize', () => ({
  useATermResize: vi.fn((options: unknown) => {
    resizeHookOptions = options as Parameters<
      typeof import('../lib/hooks/use-a-term-resize')['useATermResize']
    >[0]
    return { handleResize: resizeHandle }
  }),
}))

vi.mock('../lib/hooks/use-a-term-scrolling', () => ({
  useATermScrolling: () => ({
    setupScrolling: () => ({
      wheelCleanup: vi.fn(),
      touchCleanup: vi.fn(),
    }),
  }),
}))

vi.mock('../lib/utils/device', () => ({
  isMobileDevice: () => false,
}))

vi.mock('./ScrollToBottomPill', () => ({
  ScrollToBottomPill: () => null,
}))

describe('ATermComponent', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    websocketState.options = null
    websocketState.connect.mockClear()
    websocketState.disconnect.mockClear()
    websocketState.sendInput.mockClear()
    websocketState.wsRefCurrent = null
    websocketState.connectCalls = 0
    websocketState.disconnectCalls = 0
    operationCallbacks.length = 0
    aTermInstanceOptions = null
    aTermInstanceReady = true
    resizeHandle.mockClear()
    resizeHookOptions = null
    fakeFitAddon.proposeDimensions.mockClear()
    fakeATerm.reset.mockClear()
    fakeATerm.scrollToLine.mockClear()
    fakeATerm.write.mockClear()
    fakeATerm.buffer.active.baseY = 100
    fakeATerm.buffer.active.viewportY = 100
    fakeATerm.buffer.active.cursorY = 0
    fakeATerm.buffer.active.type = 'normal'
    fakeATerm.rows = 24
    fakeATerm.buffer.active.getLine.mockReturnValue({
      translateToString: () => 'user@host:~$ ',
    })
    window.history.replaceState({}, '', '/')
  })

  it('reports another device holding the size after a moment, and this view at once', () => {
    vi.useFakeTimers()
    const onSizeHolderChange = vi.fn()
    render(
      <ATermComponent
        sessionId="session-size"
        onSizeHolderChange={onSizeHolderChange}
      />,
    )
    onSizeHolderChange.mockClear()

    act(() => {
      websocketState.options?.onSizeHolder?.({
        here: false,
        viewer: { app: 'web', device: 'Chrome on Android' },
      })
    })
    expect(onSizeHolderChange).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onSizeHolderChange).toHaveBeenLastCalledWith('Chrome on Android')

    act(() => {
      websocketState.options?.onSizeHolder?.({ here: true, viewer: null })
    })
    expect(onSizeHolderChange).toHaveBeenLastCalledWith(null)
    vi.useRealTimers()
  })

  it('names the size holder as the notice says it', () => {
    expect(sizeHolderName({ app: 'desktop', device: 'workstation' })).toBe(
      'Aico desktop',
    )
    expect(sizeHolderName({ app: 'web', device: 'Safari on iPhone' })).toBe(
      'Safari on iPhone',
    )
    expect(sizeHolderName(null)).toBe('another device')
  })

  it('suppresses shared resize writes in observer mode', () => {
    window.history.replaceState({}, '', '/?observer=1')

    render(<ATermComponent sessionId="session-observer" isVisible />)

    expect(websocketState.options?.sendInitialResize).toBe(false)
    expect(resizeHookOptions?.sendBackendResize).toBe(false)
  })

  it('keeps shared resize writes enabled on normal pages', () => {
    render(<ATermComponent sessionId="session-standard" isVisible />)

    expect(websocketState.options?.sendInitialResize).toBe(true)
    expect(resizeHookOptions?.sendBackendResize).toBe(true)
  })

  it('claims the shared size again (handleResize) only when the view regains focus', () => {
    render(<ATermComponent sessionId="session-shared" isVisible />)
    const initialResizes = resizeHandle.mock.calls.length

    act(() => window.dispatchEvent(new Event('blur')))
    expect(resizeHookOptions?.sendBackendResize).toBe(false)
    expect(websocketState.options?.getDimensions?.()).toBeNull()
    expect(resizeHandle).toHaveBeenCalledTimes(initialResizes)

    act(() => window.dispatchEvent(new Event('focus')))
    expect(resizeHookOptions?.sendBackendResize).toBe(true)
    expect(websocketState.options?.getDimensions?.()).toEqual({
      cols: 80,
      rows: 24,
    })
    expect(resizeHandle).toHaveBeenCalledTimes(initialResizes + 1)
  })

  it('does not send shared resizes while the page is hidden', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    render(<ATermComponent sessionId="session-hidden" isVisible />)
    const initialResizes = resizeHandle.mock.calls.length

    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(resizeHookOptions?.sendBackendResize).toBe(false)
    expect(websocketState.options?.getDimensions?.()).toBeNull()

    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(resizeHookOptions?.sendBackendResize).toBe(true)
    expect(resizeHandle).toHaveBeenCalledTimes(initialResizes + 1)
    visibility.mockRestore()
  })

  it('keeps observer views passive after they regain focus', () => {
    window.history.replaceState({}, '', '/?observer=1')
    render(<ATermComponent sessionId="session-observer" isVisible />)
    resizeHandle.mockClear()

    act(() => window.dispatchEvent(new Event('blur')))
    act(() => window.dispatchEvent(new Event('focus')))

    expect(resizeHookOptions?.sendBackendResize).toBe(false)
    expect(websocketState.options?.getDimensions?.()).toBeNull()
    expect(resizeHandle).not.toHaveBeenCalled()
  })

  it('drops in-flight write side effects after resetting before reconnect sync', async () => {
    render(<ATermComponent sessionId="session-reset" />)

    websocketState.options?.onMessage?.('stale output')
    await Promise.resolve()

    expect(fakeATerm.write).toHaveBeenCalledTimes(1)
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      1,
      'stale output',
      expect.any(Function),
    )

    websocketState.options?.onBeforeReconnectData?.()
    websocketState.options?.onMessage?.('fresh output')
    await Promise.resolve()

    expect(fakeATerm.reset).toHaveBeenCalledTimes(1)
    expect(fakeATerm.write).toHaveBeenCalledTimes(1)

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeATerm.write).toHaveBeenCalledTimes(2)
    })
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      2,
      'fresh output',
      expect.any(Function),
    )

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeATerm.scrollToLine).not.toHaveBeenCalled()
  })

  it('leaves viewport following to xterm when a live write finishes', async () => {
    fakeATerm.buffer.active.baseY = 120
    fakeATerm.buffer.active.viewportY = 90

    render(<ATermComponent sessionId="session-scroll" />)

    websocketState.options?.onMessage?.('live output')
    await Promise.resolve()

    expect(fakeATerm.write).toHaveBeenCalledTimes(1)

    fakeATerm.buffer.active.baseY = 140

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeATerm.scrollToLine).not.toHaveBeenCalled()
    expect(fakeATerm.buffer.active.viewportY).toBe(90)
  })

  it('keeps large live writes intact instead of splitting escape sequences', async () => {
    render(<ATermComponent sessionId="session-paste" />)

    websocketState.options?.onMessage?.('x'.repeat(9_000))
    await Promise.resolve()

    expect(fakeATerm.write).toHaveBeenCalledTimes(1)
    expect(fakeATerm.write.mock.calls[0]?.[0]).toHaveLength(9_000)

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeATerm.write).toHaveBeenCalledTimes(1)
  })

  it('routes native a-term image paste to the session file handler', () => {
    const onFilePaste = vi.fn()
    const image = new File(['image'], 'pasted.png', { type: 'image/png' })

    render(
      <ATermComponent
        sessionId="session-native-image-paste"
        onFilePaste={onFilePaste}
      />,
    )

    act(() => {
      aTermInstanceOptions?.onFilePaste?.(image)
    })

    expect(onFilePaste).toHaveBeenCalledWith(
      image,
      'session-native-image-paste',
    )
    expect(websocketState.sendInput).not.toHaveBeenCalled()
  })

  it('forwards focused a-term input to the session', () => {
    websocketState.wsRefCurrent = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    }

    render(<ATermComponent sessionId="session-input" />)

    act(() => {
      aTermInstanceOptions?.onData('pwd')
    })

    expect(websocketState.sendInput).toHaveBeenCalledWith('pwd')
  })

  it('waits for a-term init before connecting visible A-Term sessions', () => {
    aTermInstanceReady = false

    const { rerender } = render(
      <ATermComponent sessionId="session-ready" isVisible />,
    )

    expect(websocketState.connectCalls).toBe(0)

    aTermInstanceReady = true
    rerender(<ATermComponent sessionId="session-ready" isVisible />)

    expect(websocketState.connectCalls).toBeGreaterThanOrEqual(1)
  })

  it('replays a resize once a connected a-term becomes ready', () => {
    aTermInstanceReady = false

    const { rerender } = render(
      <ATermComponent sessionId="session-resize" isVisible />,
    )

    expect(resizeHandle).not.toHaveBeenCalled()

    aTermInstanceReady = true
    rerender(<ATermComponent sessionId="session-resize" isVisible />)

    expect(resizeHandle).toHaveBeenCalledTimes(1)
  })

  it('disconnects hidden a-terms and reconnects them when visible again', () => {
    const { rerender } = render(
      <ATermComponent sessionId="session-3" isVisible={false} />,
    )

    expect(websocketState.connectCalls).toBe(0)
    expect(websocketState.disconnectCalls).toBeGreaterThanOrEqual(1)

    rerender(<ATermComponent sessionId="session-3" isVisible />)

    expect(websocketState.connectCalls).toBeGreaterThanOrEqual(1)
  })

  it('does not reconnect or disconnect a visible a-term during ordinary rerenders', () => {
    const { rerender } = render(
      <ATermComponent sessionId="session-4" isVisible />,
    )

    const connectCallsBeforeRerender = websocketState.connectCalls
    const disconnectCallsBeforeRerender = websocketState.disconnectCalls

    rerender(
      <ATermComponent
        sessionId="session-4"
        isVisible
        className="a-term-rerender"
      />,
    )

    expect(websocketState.connectCalls).toBe(connectCallsBeforeRerender)
    expect(websocketState.disconnectCalls).toBe(disconnectCallsBeforeRerender)
  })
})

describe('ATermComponent in control mode', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    websocketState.wsRefCurrent = { readyState: WebSocket.OPEN, send: vi.fn() }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    websocketState.options = null
    websocketState.wsRefCurrent = null
    websocketState.sendInput.mockClear()
    aTermInstanceOptions = null
  })

  it('keeps the pane history in xterm', () => {
    render(<ATermComponent sessionId="session-control" sessionMode="claude" />)

    expect(fakeATerm.parser.registerCsiHandler).toHaveBeenCalled()
  })

  it('holds as much history as the server says its seed carries', () => {
    render(
      <ATermComponent
        sessionId="session-control-history"
        sessionMode="claude"
      />,
    )
    // The default until the server has said.
    expect(aTermInstanceOptions?.scrollback).toBe(10_000)

    act(() => {
      websocketState.options?.onHistoryLines?.(1234)
    })

    expect(aTermInstanceOptions?.scrollback).toBe(1234)
    expect(fakeATerm.options.scrollback).toBe(1234)
  })

  it('pastes through tmux as one control message', async () => {
    render(<ATermComponent sessionId="session-control-paste" />)

    await act(async () => {
      await aTermInstanceOptions?.onPaste('a\r\nb')
    })

    expect(websocketState.sendInput).not.toHaveBeenCalled()
    expect(websocketState.wsRefCurrent?.send).toHaveBeenCalledWith(
      JSON.stringify({ __ctrl: true, paste: 'a\nb' }),
    )
  })
})
