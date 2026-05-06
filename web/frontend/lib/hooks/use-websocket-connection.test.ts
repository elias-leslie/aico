import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchControlMessage,
  openWebSocketConnection,
  type WebSocketConnectionCallbacks,
  type WebSocketConnectionRefs,
} from './use-websocket-connection'

const sockets: MockWebSocket[] = []

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  binaryType: BinaryType = 'blob'
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  readyState = MockWebSocket.CONNECTING
  sent: unknown[] = []

  constructor(readonly url: string) {
    sockets.push(this)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }

  emitClose(code = 1006, reason = '') {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  emitError() {
    this.onerror?.(new Event('error'))
  }

  send(data: unknown) {
    this.sent.push(data)
  }
}

function buildCallbacks() {
  return {
    getDimensions: vi.fn(() => null),
    onATermMessage: vi.fn(),
    onBeforeReconnectData: vi.fn(),
    onDisconnect: vi.fn(),
    onScrollbackPage: vi.fn(),
    setStatus: vi.fn(),
  }
}

function buildRefs(): WebSocketConnectionRefs {
  return {
    wsRef: { current: null },
    mountedRef: { current: true },
    connectingRef: { current: false },
    hasConnectedRef: { current: false },
    retryCountRef: { current: 0 },
    timeoutIdRef: { current: null },
    retryTimeoutRef: { current: null },
    pingIntervalRef: { current: null },
    connectRef: { current: undefined },
  }
}

function connect(
  refs: WebSocketConnectionRefs,
  callbacks: WebSocketConnectionCallbacks,
) {
  openWebSocketConnection('session-1', '/tmp', refs, callbacks)
}

afterEach(() => {
  sockets.length = 0
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('dispatchControlMessage', () => {
  it('returns false for non-control payloads', () => {
    const callbacks = buildCallbacks()

    expect(dispatchControlMessage('{"message":"hello"}', callbacks)).toBe(false)
    expect(callbacks.onScrollbackPage).not.toHaveBeenCalled()
  })

  it('swallows unknown control frames such as backpressure commits', () => {
    const callbacks = buildCallbacks()

    expect(
      dispatchControlMessage('{"__ctrl":true,"commit":262412}', callbacks),
    ).toBe(true)
    expect(callbacks.onScrollbackPage).not.toHaveBeenCalled()
  })

  it('dispatches known scrollback page control frames', () => {
    const callbacks = buildCallbacks()

    expect(
      dispatchControlMessage(
        '{"__ctrl":true,"scrollback_page":{"from_line":5,"lines":["a"],"total_lines":10}}',
        callbacks,
      ),
    ).toBe(true)
    expect(callbacks.onScrollbackPage).toHaveBeenCalledWith({
      from_line: 5,
      lines: ['a'],
      total_lines: 10,
    })
  })
})

describe('openWebSocketConnection', () => {
  it('ignores stale close events from a replaced WebSocket', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()
    refs.connectRef.current = () => connect(refs, callbacks)

    connect(refs, callbacks)
    const firstSocket = sockets[0]
    firstSocket.emitOpen()

    connect(refs, callbacks)
    const secondSocket = sockets[1]
    secondSocket.emitOpen()
    const activePingInterval = refs.pingIntervalRef.current
    callbacks.setStatus.mockClear()

    firstSocket.emitClose()

    expect(callbacks.setStatus).not.toHaveBeenCalled()
    expect(refs.wsRef.current).toBe(secondSocket)
    expect(refs.pingIntervalRef.current).toBe(activePingInterval)
  })

  it('retries unexpected close events from the active WebSocket', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()
    refs.connectRef.current = () => connect(refs, callbacks)

    connect(refs, callbacks)
    const socket = sockets[0]
    socket.emitOpen()
    callbacks.setStatus.mockClear()

    socket.emitClose()

    expect(callbacks.setStatus).toHaveBeenCalledWith('connecting')
    expect(callbacks.onDisconnect).not.toHaveBeenCalled()
    expect(refs.retryCountRef.current).toBe(1)
    expect(refs.wsRef.current).toBe(null)

    vi.advanceTimersByTime(249)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)

    expect(sockets).toHaveLength(2)
    expect(refs.wsRef.current).toBe(sockets[1])
  })

  it('does not retry a dead session close code', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()
    refs.connectRef.current = () => connect(refs, callbacks)

    connect(refs, callbacks)
    const socket = sockets[0]
    socket.emitOpen()
    callbacks.setStatus.mockClear()

    socket.emitClose(4000, '{"message":"Session dead"}')
    vi.advanceTimersByTime(1000)

    expect(callbacks.setStatus).toHaveBeenCalledWith('session_dead')
    expect(callbacks.onDisconnect).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
  })

  it('retries active error events even without a follow-up close event', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()
    refs.connectRef.current = () => connect(refs, callbacks)

    connect(refs, callbacks)
    const socket = sockets[0]
    socket.emitOpen()
    callbacks.setStatus.mockClear()

    socket.emitError()

    expect(callbacks.setStatus).toHaveBeenCalledWith('connecting')
    expect(callbacks.onDisconnect).not.toHaveBeenCalled()
    expect(refs.wsRef.current).toBe(null)

    vi.advanceTimersByTime(250)

    expect(sockets).toHaveLength(2)
    expect(refs.wsRef.current).toBe(sockets[1])
  })

  it('does not write transient retry messages into the terminal buffer', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()
    refs.connectRef.current = () => connect(refs, callbacks)

    connect(refs, callbacks)
    sockets[0].emitError()

    expect(callbacks.setStatus).toHaveBeenCalledWith('connecting')
    expect(callbacks.onATermMessage).not.toHaveBeenCalled()
  })

  it('clears any first-load retry residue when the socket eventually opens', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()
    refs.connectRef.current = () => connect(refs, callbacks)

    connect(refs, callbacks)
    sockets[0].emitError()
    vi.advanceTimersByTime(250)

    sockets[1].emitOpen()

    expect(callbacks.onBeforeReconnectData).toHaveBeenCalledTimes(1)
    expect(callbacks.onATermMessage).not.toHaveBeenCalled()
    expect(callbacks.setStatus).toHaveBeenLastCalledWith('connected')
  })
})
