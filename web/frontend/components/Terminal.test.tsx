import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalComponent } from './Terminal'

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
const resetCopyMode = vi.fn()
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
  reset: vi.fn(),
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
    resetCopyMode,
  }),
}))

vi.mock('../lib/utils/device', () => ({
  isMobileDevice: () => false,
}))

describe('TerminalComponent', () => {
  afterEach(() => {
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
    resetCopyMode.mockClear()
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

  it('suppresses shared resize writes in observer mode', () => {
    window.history.replaceState({}, '', '/?observer=1')

    render(<TerminalComponent sessionId="session-observer" isVisible />)

    expect(websocketState.options?.sendInitialResize).toBe(false)
    expect(resizeHookOptions?.sendBackendResize).toBe(false)
  })

  it('keeps shared resize writes enabled on normal pages', () => {
    render(<TerminalComponent sessionId="session-standard" isVisible />)

    expect(websocketState.options?.sendInitialResize).toBe(true)
    expect(resizeHookOptions?.sendBackendResize).toBe(true)
  })

  it('serializes live output before applying scrollback snapshots', async () => {
    render(<TerminalComponent sessionId="session-1" />)

    websocketState.options?.onMessage?.('live output')
    websocketState.options?.onScrollbackSync?.('snapshot output')
    await Promise.resolve()

    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      1,
      'live output',
      expect.any(Function),
    )
    expect(fakeTerminal.reset).not.toHaveBeenCalled()

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeTerminal.reset).toHaveBeenCalledTimes(1)
    })
    expect(fakeTerminal.write).toHaveBeenCalledTimes(2)
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      2,
      'snapshot output\x1b[0m',
      expect.any(Function),
    )
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
    websocketState.options?.onTerminalMessage?.('fresh output')
    await Promise.resolve()

    expect(fakeTerminal.reset).toHaveBeenCalledTimes(1)
    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeTerminal.write).toHaveBeenCalledTimes(2)
    })
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      2,
      'fresh output\r\n',
      expect.any(Function),
    )

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeTerminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('collapses queued writes to the latest snapshot before replaying newer output', async () => {
    render(<TerminalComponent sessionId="session-queue" />)

    websocketState.options?.onMessage?.('live-1')
    await Promise.resolve()

    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
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

    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeTerminal.reset).toHaveBeenCalledTimes(1)
      expect(fakeTerminal.write).toHaveBeenCalledTimes(2)
    })
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      2,
      'snapshot-2\x1b[0m',
      expect.any(Function),
    )

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeTerminal.write).toHaveBeenCalledTimes(3)
    })
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      3,
      'live-4',
      expect.any(Function),
    )
  })

  it('keeps the same lines in view when xterm auto-scrolls a scrolled-up viewport', async () => {
    fakeTerminal.buffer.active.baseY = 120
    fakeTerminal.buffer.active.viewportY = 90

    render(<TerminalComponent sessionId="session-scroll" />)

    websocketState.options?.onMessage?.('live output')
    await Promise.resolve()

    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)

    fakeTerminal.buffer.active.baseY = 140
    fakeTerminal.buffer.active.viewportY = 140

    operationCallbacks.shift()?.()
    await Promise.resolve()

    expect(fakeTerminal.scrollToLine).toHaveBeenCalledWith(110)
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

  it('routes native terminal paste through bracketed chunked input', async () => {
    vi.useFakeTimers()
    try {
      render(<TerminalComponent sessionId="session-native-paste" />)

      await act(async () => {
        terminalInstanceOptions?.onPaste('x'.repeat(5_000))
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

  it('resets copy mode before forwarding focused terminal input', () => {
    websocketState.wsRefCurrent = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    }

    render(<TerminalComponent sessionId="session-input" />)

    act(() => {
      terminalInstanceOptions?.onData('pwd')
    })

    expect(resetCopyMode).toHaveBeenCalledTimes(1)
    expect(websocketState.sendInput).toHaveBeenCalledWith('pwd')
  })

  it('skips snapshot replacement when it would erase locally typed prompt input', async () => {
    fakeTerminal.buffer.active.getLine.mockReturnValue({
      translateToString: (): string => 'user@host:~$ ec',
    })

    render(<TerminalComponent sessionId="session-2" />)

    websocketState.options?.onScrollbackSync?.('user@host:~$ ')
    await Promise.resolve()

    expect(fakeTerminal.reset).not.toHaveBeenCalled()
    expect(fakeTerminal.write).not.toHaveBeenCalled()
  })

  it('ignores agent-session scrollback sync snapshots and keeps live writes intact', async () => {
    fakeTerminal.buffer.active.type = 'normal'
    fakeTerminal.rows = 2

    render(
      <TerminalComponent
        sessionId="session-skipped-history"
        sessionMode="agent-codex"
      />,
    )

    websocketState.options?.onScrollbackSync?.('line-1\r\nline-2\r\nline-3\r\nline-4\r\n')
    await Promise.resolve()

    fakeTerminal.reset.mockClear()
    fakeTerminal.write.mockClear()

    websocketState.options?.onMessage?.('live-1')
    await Promise.resolve()
    websocketState.options?.onMessage?.('live-2')
    websocketState.options?.onScrollbackSync?.(
      'line-2\r\nline-3\r\nline-4\r\nline-5\r\n',
    )
    await Promise.resolve()

    expect(fakeTerminal.reset).not.toHaveBeenCalled()
    expect(fakeTerminal.write).toHaveBeenCalledTimes(1)
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      1,
      'live-1',
      expect.any(Function),
    )

    operationCallbacks.shift()?.()
    await waitFor(() => {
      expect(fakeTerminal.write).toHaveBeenCalledTimes(2)
    })
    expect(fakeTerminal.write).toHaveBeenNthCalledWith(
      2,
      'live-2',
      expect.any(Function),
    )

    fakeTerminal.reset.mockClear()
    fakeTerminal.write.mockClear()

    websocketState.options?.onScrollbackSync?.(
      'line-2\r\nline-3\r\nline-4\r\nline-5 updated\r\n',
    )
    await Promise.resolve()

    expect(fakeTerminal.reset).not.toHaveBeenCalled()
    expect(fakeTerminal.write).not.toHaveBeenCalled()
  })

  it('ignores agent-session scrollback sync snapshots for attached external panes', async () => {
    fakeTerminal.buffer.active.type = 'normal'
    fakeTerminal.rows = 2

    render(
      <TerminalComponent
        sessionId="session-external-attached"
        sessionMode="agent-codex"
      />,
    )

    websocketState.options?.onScrollbackSync?.('line-1\r\nline-2\r\nline-3\r\nline-4\r\n')
    await Promise.resolve()

    expect(fakeTerminal.reset).not.toHaveBeenCalled()
    expect(fakeTerminal.write).not.toHaveBeenCalled()

    fakeTerminal.reset.mockClear()
    fakeTerminal.write.mockClear()

    websocketState.options?.onScrollbackSync?.(
      'line-1\r\nline-2\r\nline-3\r\nline-4 updated\r\n',
    )
    await Promise.resolve()

    expect(fakeTerminal.reset).not.toHaveBeenCalled()
    expect(fakeTerminal.write).not.toHaveBeenCalled()
  })

  it('waits for terminal init before connecting visible terminals', () => {
    terminalInstanceReady = false

    const { rerender } = render(
      <TerminalComponent sessionId="session-ready" isVisible />,
    )

    expect(websocketState.connectCalls).toBe(0)

    terminalInstanceReady = true
    rerender(<TerminalComponent sessionId="session-ready" isVisible />)

    expect(websocketState.connectCalls).toBeGreaterThanOrEqual(1)
  })

  it('replays a resize once a connected terminal becomes ready', () => {
    terminalInstanceReady = false

    const { rerender } = render(
      <TerminalComponent sessionId="session-resize" isVisible />,
    )

    expect(resizeHandle).not.toHaveBeenCalled()

    terminalInstanceReady = true
    rerender(<TerminalComponent sessionId="session-resize" isVisible />)

    expect(resizeHandle).toHaveBeenCalledTimes(1)
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
