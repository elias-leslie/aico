import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ATermComponent } from './ATerm'

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
const resetCopyMode = vi.fn()
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
  reset: vi.fn(),
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
    resetCopyMode,
  }),
}))

vi.mock('../lib/utils/device', () => ({
  isMobileDevice: () => false,
}))

describe('ATermComponent', () => {
  afterEach(() => {
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
    resetCopyMode.mockClear()
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

  it('serializes live output before applying scrollback snapshots', async () => {
    render(<ATermComponent sessionId="session-1" />)

    websocketState.options?.onMessage?.('live output')
    websocketState.options?.onScrollbackSync?.('snapshot output')
    await Promise.resolve()

    expect(fakeATerm.write).toHaveBeenCalledTimes(1)
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      1,
      'live output',
      expect.any(Function),
    )
    expect(fakeATerm.reset).not.toHaveBeenCalled()

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeATerm.reset).toHaveBeenCalledTimes(1)
    })
    expect(fakeATerm.write).toHaveBeenCalledTimes(2)
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      2,
      'snapshot output\x1b[0m',
      expect.any(Function),
    )
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
    websocketState.options?.onATermMessage?.('fresh output')
    await Promise.resolve()

    expect(fakeATerm.reset).toHaveBeenCalledTimes(1)
    expect(fakeATerm.write).toHaveBeenCalledTimes(1)

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeATerm.write).toHaveBeenCalledTimes(2)
    })
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      2,
      'fresh output\r\n',
      expect.any(Function),
    )

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeATerm.scrollToLine).not.toHaveBeenCalled()
  })

  it('collapses queued writes to the latest snapshot before replaying newer output', async () => {
    render(<ATermComponent sessionId="session-queue" />)

    websocketState.options?.onMessage?.('live-1')
    await Promise.resolve()

    expect(fakeATerm.write).toHaveBeenCalledTimes(1)
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      1,
      'live-1',
      expect.any(Function),
    )

    websocketState.options?.onMessage?.('live-2')
    websocketState.options?.onScrollbackSync?.('snapshot-1')
    websocketState.options?.onMessage?.('live-3')
    websocketState.options?.onScrollbackSync?.('snapshot-2')
    websocketState.options?.onMessage?.('live-4')
    await Promise.resolve()

    expect(fakeATerm.write).toHaveBeenCalledTimes(1)

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeATerm.reset).toHaveBeenCalledTimes(1)
      expect(fakeATerm.write).toHaveBeenCalledTimes(2)
    })
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      2,
      'snapshot-2\x1b[0m',
      expect.any(Function),
    )

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeATerm.write).toHaveBeenCalledTimes(3)
    })
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      3,
      'live-4',
      expect.any(Function),
    )
  })

  it('keeps the same lines in view when xterm auto-scrolls a scrolled-up viewport', async () => {
    fakeATerm.buffer.active.baseY = 120
    fakeATerm.buffer.active.viewportY = 90

    render(<ATermComponent sessionId="session-scroll" />)

    websocketState.options?.onMessage?.('live output')
    await Promise.resolve()

    expect(fakeATerm.write).toHaveBeenCalledTimes(1)

    fakeATerm.buffer.active.baseY = 140
    fakeATerm.buffer.active.viewportY = 140

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeATerm.scrollToLine).toHaveBeenCalledWith(110)
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

  it('routes native a-term paste through bracketed chunked input', async () => {
    vi.useFakeTimers()
    try {
      render(<ATermComponent sessionId="session-native-paste" />)

      await act(async () => {
        aTermInstanceOptions?.onPaste('x'.repeat(5_000))
        await vi.runAllTimersAsync()
      })

      expect(websocketState.sendInput).toHaveBeenCalledTimes(7)
      expect(websocketState.sendInput).toHaveBeenNthCalledWith(1, '\x1b[200~')
      expect(websocketState.sendInput.mock.calls[1]?.[0]).toHaveLength(1_024)
      expect(websocketState.sendInput.mock.calls[2]?.[0]).toHaveLength(1_024)
      expect(websocketState.sendInput.mock.calls[3]?.[0]).toHaveLength(1_024)
      expect(websocketState.sendInput.mock.calls[4]?.[0]).toHaveLength(1_024)
      expect(websocketState.sendInput.mock.calls[5]?.[0]).toHaveLength(904)
      expect(websocketState.sendInput).toHaveBeenNthCalledWith(7, '\x1b[201~')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets copy mode before forwarding focused a-term input', () => {
    websocketState.wsRefCurrent = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    }

    render(<ATermComponent sessionId="session-input" />)

    act(() => {
      aTermInstanceOptions?.onData('pwd')
    })

    expect(resetCopyMode).toHaveBeenCalledTimes(1)
    expect(websocketState.sendInput).toHaveBeenCalledWith('pwd')
  })

  it('skips snapshot replacement when it would erase locally typed prompt input', async () => {
    fakeATerm.buffer.active.getLine.mockReturnValue({
      translateToString: (): string => 'user@host:~$ ec',
    })

    render(<ATermComponent sessionId="session-2" />)

    websocketState.options?.onScrollbackSync?.('user@host:~$ ')
    await Promise.resolve()

    expect(fakeATerm.reset).not.toHaveBeenCalled()
    expect(fakeATerm.write).not.toHaveBeenCalled()
  })

  it('ignores agent-session scrollback sync snapshots and keeps live writes intact', async () => {
    fakeATerm.buffer.active.type = 'normal'
    fakeATerm.rows = 2

    render(
      <ATermComponent
        sessionId="session-skipped-history"
        sessionMode="agent-codex"
      />,
    )

    websocketState.options?.onScrollbackSync?.('line-1\r\nline-2\r\nline-3\r\nline-4\r\n')
    await Promise.resolve()

    fakeATerm.reset.mockClear()
    fakeATerm.write.mockClear()

    websocketState.options?.onMessage?.('live-1')
    await Promise.resolve()
    websocketState.options?.onMessage?.('live-2')
    websocketState.options?.onScrollbackSync?.(
      'line-2\r\nline-3\r\nline-4\r\nline-5\r\n',
    )
    await Promise.resolve()

    expect(fakeATerm.reset).not.toHaveBeenCalled()
    expect(fakeATerm.write).toHaveBeenCalledTimes(1)
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      1,
      'live-1',
      expect.any(Function),
    )

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeATerm.write).toHaveBeenCalledTimes(2)
    })
    expect(fakeATerm.write).toHaveBeenNthCalledWith(
      2,
      'live-2',
      expect.any(Function),
    )

    fakeATerm.reset.mockClear()
    fakeATerm.write.mockClear()

    websocketState.options?.onScrollbackSync?.(
      'line-2\r\nline-3\r\nline-4\r\nline-5 updated\r\n',
    )
    await Promise.resolve()

    expect(fakeATerm.reset).not.toHaveBeenCalled()
    expect(fakeATerm.write).not.toHaveBeenCalled()
  })

  it('ignores agent-session scrollback sync snapshots for attached external panes', async () => {
    fakeATerm.buffer.active.type = 'normal'
    fakeATerm.rows = 2

    render(
      <ATermComponent
        sessionId="session-external-attached"
        sessionMode="agent-codex"
      />,
    )

    websocketState.options?.onScrollbackSync?.('line-1\r\nline-2\r\nline-3\r\nline-4\r\n')
    await Promise.resolve()

    expect(fakeATerm.reset).not.toHaveBeenCalled()
    expect(fakeATerm.write).not.toHaveBeenCalled()

    fakeATerm.reset.mockClear()
    fakeATerm.write.mockClear()

    websocketState.options?.onScrollbackSync?.(
      'line-1\r\nline-2\r\nline-3\r\nline-4 updated\r\n',
    )
    await Promise.resolve()

    expect(fakeATerm.reset).not.toHaveBeenCalled()
    expect(fakeATerm.write).not.toHaveBeenCalled()
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
