import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWebSocket } from './use-terminal-websocket'

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

  constructor(readonly url: string) {
    sockets.push(this)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  send() {}
}

beforeEach(() => {
  sockets.length = 0
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useTerminalWebSocket network changes', () => {
  it('stops showing Live when the device goes offline and opens a fresh socket when it is back', () => {
    const { result } = renderHook(() =>
      useTerminalWebSocket({ sessionId: 's1', sendInitialResize: false }),
    )
    act(() => result.current.connect())
    act(() => sockets[0]?.emitOpen())
    expect(result.current.status).toBe('connected')

    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(result.current.status).toBe('connecting')
    expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED)
    expect(sockets).toHaveLength(1)

    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(sockets).toHaveLength(2)
    act(() => sockets[1]?.emitOpen())
    expect(result.current.status).toBe('connected')
  })
})
