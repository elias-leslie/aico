import { act, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sizeHolderName,
  TerminalComponent,
  type TerminalHandle,
} from './Terminal'

type TerminalHookOptions = Parameters<
  typeof import('../lib/hooks/use-terminal-websocket')['useTerminalWebSocket']
>[0]

const websocketState: {
  options: TerminalHookOptions | null
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
let terminalInstanceOptions:
  | Parameters<
      typeof import('../lib/hooks/use-terminal-instance')['useTerminalInstance']
    >[0]
  | null = null
let terminalInstanceReady = true
const resizeHandle = vi.fn()
let resizeHookOptions:
  | Parameters<
      typeof import('../lib/hooks/use-terminal-resize')['useTerminalResize']
    >[0]
  | null = null

const fakeTerminal = {
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

vi.mock('../lib/hooks/use-terminal-websocket', () => ({
  useTerminalWebSocket: (options: TerminalHookOptions) => {
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

vi.mock('../lib/hooks/use-terminal-instance', () => ({
  useTerminalInstance: (
    options: unknown,
    refs: {
      terminalRef: { current: typeof fakeTerminal | null }
      fitAddonRef: { current: typeof fakeFitAddon | null }
      isFocusedRef: { current: boolean }
    },
  ) => {
    terminalInstanceOptions = options as Parameters<
      typeof import('../lib/hooks/use-terminal-instance')['useTerminalInstance']
    >[0]
    refs.terminalRef.current = fakeTerminal
    refs.fitAddonRef.current = fakeFitAddon
    refs.isFocusedRef.current = true
    return { isReady: terminalInstanceReady }
  },
}))

vi.mock('../lib/hooks/use-terminal-resize', () => ({
  useTerminalResize: vi.fn((options: unknown) => {
    resizeHookOptions = options as Parameters<
      typeof import('../lib/hooks/use-terminal-resize')['useTerminalResize']
    >[0]
    return { handleResize: resizeHandle }
  }),
}))

vi.mock('../lib/hooks/use-terminal-scrolling', () => ({
  useTerminalScrolling: () => ({
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

describe('TerminalComponent', () => {
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
    terminalInstanceOptions = null
    terminalInstanceReady = true
    resizeHandle.mockClear()
    resizeHookOptions = null
    fakeFitAddon.proposeDimensions.mockClear()
    fakeTerminal.reset.mockClear()
    fakeTerminal.scrollToLine.mockClear()
    fakeTerminal.write.mockClear()
    fakeTerminal.buffer.active.baseY = 100
    fakeTerminal.buffer.active.viewportY = 100
    fakeTerminal.buffer.active.cursorY = 0
    fakeTerminal.buffer.active.type = 'normal'
    fakeTerminal.rows = 24
    fakeTerminal.buffer.active.getLine.mockReturnValue({
      translateToString: () => 'user@host:~$ ',
    })
    window.history.replaceState({}, '', '/')
  })

  it('reports another device holding the size after a moment, and this view at once', () => {
    vi.useFakeTimers()
    const onSizeHolderChange = vi.fn()
    render(
      <TerminalComponent
        sessionId="session-size"
        onSizeHolderChange={onSizeHolderChange}
      />,
    )
    onSizeHolderChange.mockClear()

    act(() => {
      websocketState.options?.onSizeHolder?.({
        here: false,
        viewer: { app: 'web', device: 'Chrome on Android' },
        size: null,
      })
    })
    expect(onSizeHolderChange).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onSizeHolderChange).toHaveBeenLastCalledWith('Chrome on Android')

    act(() => {
      websocketState.options?.onSizeHolder?.({
        here: true,
        viewer: null,
        size: null,
      })
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

  it('an observer sends no size and never claims, even when typing', () => {
    window.history.replaceState({}, '', '/?observer=1')
    websocketState.wsRefCurrent = { readyState: WebSocket.OPEN, send: vi.fn() }

    render(<TerminalComponent sessionId="session-observer" isVisible />)
    act(() => terminalInstanceOptions?.onData('x'))

    expect(websocketState.options?.sendInitialResize).toBe(false)
    expect(websocketState.options?.getDimensions?.()).toBeNull()
    expect(resizeHookOptions?.canClaim).toBe(false)
    expect(resizeHandle).not.toHaveBeenCalled()
  })

  it('opening, focusing or showing a session claims nothing; it offers its size unclaimed', () => {
    render(<TerminalComponent sessionId="session-look" isVisible />)
    act(() => window.dispatchEvent(new Event('blur')))
    act(() => window.dispatchEvent(new Event('focus')))
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(resizeHandle).not.toHaveBeenCalled()
    expect(resizeHookOptions?.holdsSize).toBe(false)
    expect(websocketState.options?.sendInitialResize).toBe(true)
    expect(websocketState.options?.getDimensions?.()).toEqual({
      cols: 80,
      rows: 24,
    })
  })

  it("shows the session at the holder's size until this view takes it", () => {
    render(<TerminalComponent sessionId="session-view" isVisible />)
    act(() =>
      websocketState.options?.onSizeHolder?.({
        here: false,
        viewer: { app: 'desktop', device: 'box' },
        size: { cols: 200, rows: 60 },
      }),
    )
    expect(resizeHookOptions?.viewSize).toEqual({ cols: 200, rows: 60 })
    expect(resizeHookOptions?.holdsSize).toBe(false)

    act(() =>
      websocketState.options?.onSizeHolder?.({
        here: true,
        viewer: null,
        size: null,
      }),
    )
    expect(resizeHookOptions?.viewSize).toBeNull()
    expect(resizeHookOptions?.holdsSize).toBe(true)
  })

  it('the first input claims the size, spaced out, and not once this view holds it', () => {
    vi.useFakeTimers()
    websocketState.wsRefCurrent = { readyState: WebSocket.OPEN, send: vi.fn() }
    const ref = createRef<TerminalHandle>()
    render(<TerminalComponent ref={ref} sessionId="session-use" isVisible />)
    act(() =>
      websocketState.options?.onSizeHolder?.({
        here: false,
        viewer: null,
        size: { cols: 200, rows: 60 },
      }),
    )

    act(() => terminalInstanceOptions?.onData('l'))
    act(() => terminalInstanceOptions?.onData('s'))
    expect(websocketState.sendInput.mock.calls).toEqual([['l'], ['s']])
    expect(resizeHandle).toHaveBeenCalledTimes(1)
    expect(resizeHookOptions?.viewSize).toBeNull()

    // Toolbar keys and compose go through the handle; a paste too.
    act(() => vi.advanceTimersByTime(1600))
    act(() => ref.current?.sendInput('\r'))
    expect(resizeHandle).toHaveBeenCalledTimes(2)

    act(() =>
      websocketState.options?.onSizeHolder?.({
        here: true,
        viewer: null,
        size: null,
      }),
    )
    act(() => vi.advanceTimersByTime(1600))
    act(() => terminalInstanceOptions?.onData('x'))
    void ref.current?.pasteInput('y')
    expect(resizeHandle).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('Use here claims at once', () => {
    const ref = createRef<TerminalHandle>()
    render(
      <TerminalComponent ref={ref} sessionId="session-use-here" isVisible />,
    )
    act(() => ref.current?.claimSize())
    expect(resizeHandle).toHaveBeenCalledTimes(1)
  })

  it('drops in-flight write side effects after resetting before reconnect sync', async () => {
    render(<TerminalComponent sessionId="session-reset" />)

    websocketState.options?.onMessage?.('stale output')
    await Promise.resolve()

    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      1,
      'stale output',
      expect.any(Function),
    )

    websocketState.options?.onBeforeReconnectData?.()
    websocketState.options?.onMessage?.('fresh output')
    await Promise.resolve()

    expect(fakeTerminal.reset).toHaveBeenCalledTimes(1)
    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeTerminal.write).toHaveBeenCalledTimes(2)
    })
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      2,
      'fresh output',
      expect.any(Function),
    )

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeTerminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('leaves viewport following to xterm when a live write finishes', async () => {
    fakeTerminal.buffer.active.baseY = 120
    fakeTerminal.buffer.active.viewportY = 90

    render(<TerminalComponent sessionId="session-scroll" />)

    websocketState.options?.onMessage?.('live output')
    await Promise.resolve()

    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)

    fakeTerminal.buffer.active.baseY = 140

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeTerminal.scrollToLine).not.toHaveBeenCalled()
    expect(fakeTerminal.buffer.active.viewportY).toBe(90)
  })

  it('keeps large live writes intact instead of splitting escape sequences', async () => {
    render(<TerminalComponent sessionId="session-paste" />)

    websocketState.options?.onMessage?.('x'.repeat(9_000))
    await Promise.resolve()

    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)
    expect(fakeTerminal.write.mock.calls[0]?.[0]).toHaveLength(9_000)

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)
  })

  it('routes native terminal image paste to the session file handler', () => {
    const onFilePaste = vi.fn()
    const image = new File(['image'], 'pasted.png', { type: 'image/png' })

    render(
      <TerminalComponent
        sessionId="session-native-image-paste"
        onFilePaste={onFilePaste}
      />,
    )

    act(() => {
      terminalInstanceOptions?.onFilePaste?.(image)
    })

    expect(onFilePaste).toHaveBeenCalledWith(
      image,
      'session-native-image-paste',
    )
    expect(websocketState.sendInput).not.toHaveBeenCalled()
  })

  it('forwards focused terminal input to the session', () => {
    websocketState.wsRefCurrent = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    }

    render(<TerminalComponent sessionId="session-input" />)

    act(() => {
      terminalInstanceOptions?.onData('pwd')
    })

    expect(websocketState.sendInput).toHaveBeenCalledWith('pwd')
  })

  it('waits for terminal init before connecting visible sessions', () => {
    terminalInstanceReady = false

    const { rerender } = render(
      <TerminalComponent sessionId="session-ready" isVisible />,
    )

    expect(websocketState.connectCalls).toBe(0)

    terminalInstanceReady = true
    rerender(<TerminalComponent sessionId="session-ready" isVisible />)

    expect(websocketState.connectCalls).toBeGreaterThanOrEqual(1)
  })

  it('disconnects hidden terminals and reconnects them when visible again', () => {
    const { rerender } = render(
      <TerminalComponent sessionId="session-3" isVisible={false} />,
    )

    expect(websocketState.connectCalls).toBe(0)
    expect(websocketState.disconnectCalls).toBeGreaterThanOrEqual(1)

    rerender(<TerminalComponent sessionId="session-3" isVisible />)

    expect(websocketState.connectCalls).toBeGreaterThanOrEqual(1)
  })

  it('does not reconnect or disconnect a visible terminal during ordinary rerenders', () => {
    const { rerender } = render(
      <TerminalComponent sessionId="session-4" isVisible />,
    )

    const connectCallsBeforeRerender = websocketState.connectCalls
    const disconnectCallsBeforeRerender = websocketState.disconnectCalls

    rerender(
      <TerminalComponent
        sessionId="session-4"
        isVisible
        className="terminal-rerender"
      />,
    )

    expect(websocketState.connectCalls).toBe(connectCallsBeforeRerender)
    expect(websocketState.disconnectCalls).toBe(disconnectCallsBeforeRerender)
  })
})

describe('TerminalComponent in control mode', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    websocketState.wsRefCurrent = { readyState: WebSocket.OPEN, send: vi.fn() }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    websocketState.options = null
    websocketState.wsRefCurrent = null
    websocketState.sendInput.mockClear()
    terminalInstanceOptions = null
  })

  it('keeps the pane history in xterm', () => {
    render(
      <TerminalComponent sessionId="session-control" sessionMode="claude" />,
    )

    expect(fakeTerminal.parser.registerCsiHandler).toHaveBeenCalled()
  })

  it('holds as much history as the server says its seed carries', () => {
    render(
      <TerminalComponent
        sessionId="session-control-history"
        sessionMode="claude"
      />,
    )
    // The default until the server has said.
    expect(terminalInstanceOptions?.scrollback).toBe(10_000)

    act(() => {
      websocketState.options?.onHistoryLines?.(1234)
    })

    expect(terminalInstanceOptions?.scrollback).toBe(1234)
    expect(fakeTerminal.options.scrollback).toBe(1234)
  })

  it('pastes through tmux as one control message', async () => {
    render(<TerminalComponent sessionId="session-control-paste" />)

    await act(async () => {
      await terminalInstanceOptions?.onPaste('a\r\nb')
    })

    expect(websocketState.sendInput).not.toHaveBeenCalled()
    expect(websocketState.wsRefCurrent?.send).toHaveBeenCalledWith(
      JSON.stringify({ __ctrl: true, paste: 'a\nb' }),
    )
  })
})
