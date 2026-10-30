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
    onMessage: vi.fn(),
    onSizeHolder: vi.fn(),
    onBeforeReconnectData: vi.fn(),
    onDisconnect: vi.fn(),
    onHistoryLines: vi.fn(),
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
    expect(callbacks.onHistoryLines).not.toHaveBeenCalled()
  })

  it('swallows unknown control frames', () => {
    const callbacks = buildCallbacks()

    expect(
      dispatchControlMessage('{"__ctrl":true,"commit":262412}', callbacks),
    ).toBe(true)
    expect(callbacks.onHistoryLines).not.toHaveBeenCalled()
  })

  it('reports how much history the seed carries', () => {
    const callbacks = buildCallbacks()

    expect(
      dispatchControlMessage(
        '{"__ctrl":true,"transport":"control","history_lines":20000}',
        callbacks,
      ),
    ).toBe(true)
    expect(callbacks.onHistoryLines).toHaveBeenCalledWith(20000)
  })

  it("reports a remote session's host state", () => {
    const onHostState = vi.fn()
    const callbacks = { ...buildCallbacks(), onHostState }

    expect(
      dispatchControlMessage(
        '{"__ctrl":true,"host_state":{"host":"agent-work","state":"offline"}}',
        callbacks,
      ),
    ).toBe(true)
    expect(onHostState).toHaveBeenCalledWith({
      host: 'agent-work',
      state: 'offline',
    })
    dispatchControlMessage('{"__ctrl":true,"host_state":{"host":7}}', callbacks)
    expect(onHostState).toHaveBeenCalledTimes(1)
  })
})

describe('openWebSocketConnection', () => {
  it('negotiates capabilities without resizing when dimensions are suppressed', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()

    connect(refs, callbacks)
    sockets[0].emitOpen()

    expect(callbacks.getDimensions).toHaveBeenCalledOnce()
    expect(sockets[0].sent).toHaveLength(1)
    expect(JSON.parse(sockets[0].sent[0] as string)).toEqual({
      __ctrl: true,
      capabilities: ['binary_protocol'],
    })
  })

  it('offers its size on connect without claiming it: opening does not resize', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()
    callbacks.getDimensions.mockReturnValue({ cols: 120, rows: 40 } as never)

    connect(refs, callbacks)
    sockets[0].emitOpen()

    expect(JSON.parse(sockets[0].sent[0] as string)).toEqual({
      __ctrl: true,
      resize: { cols: 120, rows: 40 },
      capabilities: ['binary_protocol'],
    })
  })

  it('negotiates observer capabilities without reading terminal dimensions', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()

    openWebSocketConnection('session-observer', undefined, refs, {
      ...callbacks,
      sendInitialResize: false,
    })
    sockets[0].emitOpen()

    expect(callbacks.getDimensions).not.toHaveBeenCalled()
    expect(JSON.parse(sockets[0].sent[0] as string)).toEqual({
      __ctrl: true,
      capabilities: ['binary_protocol'],
    })
  })

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
    expect(callbacks.onMessage).not.toHaveBeenCalled()
  })

  it('leaves the out-of-retries state to the notice, writing nothing into the terminal', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const refs = buildRefs()
    const callbacks = buildCallbacks()
    refs.connectRef.current = () => connect(refs, callbacks)

    connect(refs, callbacks)
    for (let attempt = 0; attempt <= 30; attempt += 1) {
      sockets[sockets.length - 1].emitError()
      vi.advanceTimersByTime(2000)
    }

    expect(callbacks.setStatus).toHaveBeenLastCalledWith('error')
    expect(callbacks.onDisconnect).toHaveBeenCalledTimes(1)
    expect(callbacks.onMessage).not.toHaveBeenCalled()
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
    expect(callbacks.onMessage).not.toHaveBeenCalled()
    expect(callbacks.setStatus).toHaveBeenLastCalledWith('connected')
  })
})

describe('size holder', () => {
  it('reports who holds the shared size', () => {
    const callbacks = buildCallbacks()
    dispatchControlMessage(
      '{"__ctrl":true,"size_holder":{"here":false,"viewer":{"app":"web","device":"Chrome on Android"},"size":{"cols":120,"rows":40}}}',
      callbacks,
    )
    dispatchControlMessage(
      '{"__ctrl":true,"size_holder":{"here":true,"viewer":{"app":1},"size":{"cols":0,"rows":4}}}',
      callbacks,
    )
    dispatchControlMessage('{"__ctrl":true,"size_holder":{}}', callbacks)
    expect(callbacks.onSizeHolder.mock.calls).toEqual([
      [
        {
          here: false,
          viewer: { app: 'web', device: 'Chrome on Android' },
          size: { cols: 120, rows: 40 },
        },
      ],
      [{ here: true, viewer: null, size: null }],
    ])
  })
})

describe('history lines', () => {
  it('ignores a history size that is not a positive number', () => {
    const callbacks = buildCallbacks()
    dispatchControlMessage(
      '{"__ctrl":true,"transport":"control","history_lines":"lots"}',
      callbacks,
    )
    dispatchControlMessage('{"__ctrl":true,"transport":"control"}', callbacks)
    expect(callbacks.onHistoryLines).not.toHaveBeenCalled()
  })

  it('connects without any transport query', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    openWebSocketConnection('session-1', '/tmp', buildRefs(), buildCallbacks())
    expect(sockets[0].url).toMatch(/\/ws\/session-1\?working_dir=%2Ftmp$/)
  })
})
