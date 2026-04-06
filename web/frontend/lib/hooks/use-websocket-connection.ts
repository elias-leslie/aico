'use client'

import type React from 'react'
import type { ScrollbackDelta } from '../a-term/line-cache'
import { getWsUrl } from '../api-config'
import {
  CONNECTION_TIMEOUT,
  WS_CLOSE_CODE_SESSION_DEAD,
  WS_CLIENT_PING_INTERVAL,
  BACKPRESSURE_COMMIT_INTERVAL,
} from '../constants/a-term'

export interface WebSocketConnectionRefs {
  wsRef: React.MutableRefObject<WebSocket | null>
  mountedRef: React.MutableRefObject<boolean>
  connectingRef: React.MutableRefObject<boolean>
  hasConnectedRef: React.MutableRefObject<boolean>
  retryCountRef: React.MutableRefObject<number>
  timeoutIdRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  retryTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  pingIntervalRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>
  connectRef: React.MutableRefObject<(() => void) | undefined>
}

export interface WebSocketConnectionCallbacks {
  onATermMessage?: (message: string) => void
  onMessage?: (data: string) => void
  onScrollbackSync?: (
    scrollback: string,
    cursorPosition?: { x: number; y: number },
  ) => void
  onScrollbackDelta?: (delta: ScrollbackDelta) => void
  onViewportInit?: (data: {
    lines: string
    cursor_position?: { x: number; y: number }
    total_lines: number
    viewport_start_line: number
  }) => void
  onScrollbackPage?: (data: {
    from_line: number
    lines: string[]
    total_lines: number
  }) => void
  onBeforeReconnectData?: () => void
  onDisconnect?: () => void
  getDimensions?: () => { cols: number; rows: number } | null
  sendInitialResize?: boolean
  setStatus: (status: string) => void
}

// Binary protocol message types (must match backend)
const MSG_OUTPUT = 0x01
const MSG_INPUT = 0x01 // client→server input (same value as OUTPUT, different direction)
const MSG_CONTROL = 0x02

/** Client capabilities advertised in the initial resize message. */
const CLIENT_CAPABILITIES = ['backpressure', 'diff_sync', 'binary_protocol', 'demand_paging']

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Build and open a WebSocket, wiring all event handlers for connection lifecycle. */
export function openWebSocketConnection(
  sessionId: string,
  workingDir: string | undefined,
  refs: WebSocketConnectionRefs,
  callbacks: WebSocketConnectionCallbacks,
): void {
  const {
    wsRef,
    mountedRef,
    connectingRef,
    hasConnectedRef,
    retryCountRef,
    timeoutIdRef,
    retryTimeoutRef,
    pingIntervalRef,
    connectRef,
  } = refs
  const {
    onATermMessage,
    onMessage,
    onBeforeReconnectData,
    onDisconnect,
    getDimensions,
    sendInitialResize = true,
    setStatus,
  } = callbacks

  // Close any existing connection
  if (wsRef.current) {
    wsRef.current.close()
    wsRef.current = null
  }
  if (timeoutIdRef.current) {
    clearTimeout(timeoutIdRef.current)
    timeoutIdRef.current = null
  }
  if (retryTimeoutRef.current) {
    clearTimeout(retryTimeoutRef.current)
    retryTimeoutRef.current = null
  }
  if (pingIntervalRef.current) {
    clearInterval(pingIntervalRef.current)
    pingIntervalRef.current = null
  }

  let wsPath = `/ws/a-term/${sessionId}`
  if (workingDir) {
    wsPath += `?working_dir=${encodeURIComponent(workingDir)}`
  }

  let ws: WebSocket
  try {
    ws = new WebSocket(getWsUrl(wsPath))
    ws.binaryType = 'arraybuffer'
  } catch {
    connectingRef.current = false
    setStatus('error')
    onATermMessage?.('\r\n\x1b[31mFailed to create WebSocket connection\x1b[0m')
    return
  }
  wsRef.current = ws

  // Phase 1: Backpressure tracking
  let bytesReceived = 0
  let lastCommit = 0

  // Set up connection timeout with exponential-backoff retry
  timeoutIdRef.current = setTimeout(() => {
    if (ws.readyState !== WebSocket.CONNECTING) return
    ws.close()
    if (!mountedRef.current) return

    const maxRetries = 10
    if (retryCountRef.current < maxRetries) {
      const delay = Math.min(1000 * 2 ** retryCountRef.current, 30000)
      retryCountRef.current += 1
      onATermMessage?.(
        `\x1b[33mConnection timeout, retrying (${retryCountRef.current}/${maxRetries})...\x1b[0m`,
      )
      setStatus('connecting')
      retryTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) connectRef.current?.()
      }, delay)
    } else {
      setStatus('timeout')
      onATermMessage?.('\r\n\x1b[31mConnection timeout after maximum retries\x1b[0m')
      onDisconnect?.()
    }
  }, CONNECTION_TIMEOUT)

  ws.onopen = () => {
    connectingRef.current = false
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current)
    if (!mountedRef.current) return

    retryCountRef.current = 0
    setStatus('connected')

    if (!hasConnectedRef.current) {
      hasConnectedRef.current = true
      onATermMessage?.(`Connected to a-term session: ${sessionId}`)
      onATermMessage?.('')
    } else {
      onBeforeReconnectData?.()
    }

    // Client-side keepalive ping to prevent reverse proxies (e.g. Cloudflare)
    // from dropping idle WebSocket connections due to no client->server traffic.
    pingIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ __ctrl: true, ping: true }))
      }
    }, WS_CLIENT_PING_INTERVAL)

    // Send initial resize with client capabilities (feature negotiation)
    const dims = sendInitialResize ? getDimensions?.() : null
    if (dims) {
      ws.send(
        JSON.stringify({
          __ctrl: true,
          resize: { cols: dims.cols, rows: dims.rows },
          capabilities: CLIENT_CAPABILITIES,
        }),
      )
    }
  }

  ws.onmessage = (event) => {
    if (!mountedRef.current) return
    try {
      // Phase 5: Binary protocol handling
      if (event.data instanceof ArrayBuffer) {
        const view = new Uint8Array(event.data)
        if (view.length < 1) return

        // Phase 1: Track bytes for backpressure
        bytesReceived += view.length
        if (bytesReceived - lastCommit >= BACKPRESSURE_COMMIT_INTERVAL) {
          lastCommit = bytesReceived
          ws.send(JSON.stringify({ __ctrl: true, commit: bytesReceived }))
        }

        const msgType = view[0]
        const payload = view.subarray(1)

        if (msgType === MSG_OUTPUT) {
          onMessage?.(textDecoder.decode(payload))
          return
        }
        if (msgType === MSG_CONTROL) {
          const controlText = textDecoder.decode(payload)
          dispatchControlMessage(controlText, callbacks)
          return
        }
        // Unknown binary type — treat as raw output
        onMessage?.(textDecoder.decode(view))
        return
      }

      // Text protocol (legacy / backward compat)
      if (typeof event.data === 'string') {
        // Phase 1: Track bytes for backpressure
        bytesReceived += new Blob([event.data]).size
        if (bytesReceived - lastCommit >= BACKPRESSURE_COMMIT_INTERVAL) {
          lastCommit = bytesReceived
          ws.send(JSON.stringify({ __ctrl: true, commit: bytesReceived }))
        }

        if (event.data.startsWith('{')) {
          if (dispatchControlMessage(event.data, callbacks)) {
            return
          }
        }
        onMessage?.(event.data)
      } else if (event.data instanceof Blob) {
        event.data.text().then((text) => onMessage?.(text))
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error)
    }
  }

  ws.onclose = (event) => {
    connectingRef.current = false
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current)
    if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
    if (!mountedRef.current) return

    if (event.code === WS_CLOSE_CODE_SESSION_DEAD) {
      setStatus('session_dead')
      try {
        const reason = JSON.parse(event.reason)
        onATermMessage?.(`\r\n\x1b[31m${reason.message || 'Session not found'}\x1b[0m`)
      } catch {
        onATermMessage?.('\r\n\x1b[31mSession not found or could not be restored\x1b[0m')
      }
    } else {
      setStatus('disconnected')
      onATermMessage?.('\r\n\x1b[31mDisconnected from a-term\x1b[0m')
    }
    onDisconnect?.()
  }

  ws.onerror = () => {
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current)
    if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
    if (!mountedRef.current) return
    setStatus('error')
    onATermMessage?.('\r\n\x1b[31mConnection error\x1b[0m')
  }
}

/**
 * Dispatch a JSON control message to the appropriate callback.
 * Returns true if the message was handled as a control message.
 */
export function dispatchControlMessage(
  text: string,
  callbacks: WebSocketConnectionCallbacks,
): boolean {
  try {
    const control = JSON.parse(text) as Record<string, unknown>
    if (!control.__ctrl) return false

    // Scrollback sync (legacy full snapshot)
    if (typeof control.scrollback_sync === 'string') {
      const hasCursorPosition =
        Number.isInteger(control.scrollback_cursor_x) &&
        Number.isInteger(control.scrollback_cursor_y)
      callbacks.onScrollbackSync?.(
        control.scrollback_sync,
        hasCursorPosition
          ? {
              x: control.scrollback_cursor_x as number,
              y: control.scrollback_cursor_y as number,
            }
          : undefined,
      )
      return true
    }

    // Phase 2: Scrollback delta
    if (control.scrollback_delta) {
      callbacks.onScrollbackDelta?.(control.scrollback_delta as ScrollbackDelta)
      return true
    }

    // Phase 3: Viewport init
    if (control.viewport_init) {
      callbacks.onViewportInit?.(
        control.viewport_init as {
          lines: string
          cursor_position?: { x: number; y: number }
          total_lines: number
          viewport_start_line: number
        },
      )
      return true
    }

    // Phase 3: Scrollback page response
    if (control.scrollback_page) {
      callbacks.onScrollbackPage?.(
        control.scrollback_page as {
          from_line: number
          lines: string[]
          total_lines: number
        },
      )
      return true
    }

    // Unknown control frames still belong to the control channel and should
    // never be rendered into the visible aTerm buffer.
    return true
  } catch {
    return false
  }
}

/**
 * Send input via binary protocol when available, text otherwise.
 */
export function sendBinaryInput(ws: WebSocket, data: string): void {
  const encoded = textEncoder.encode(data)
  const frame = new Uint8Array(1 + encoded.length)
  frame[0] = MSG_INPUT
  frame.set(encoded, 1)
  ws.send(frame)
}

/**
 * Send a control message via binary protocol.
 */
export function sendBinaryControl(ws: WebSocket, payload: Record<string, unknown>): void {
  const encoded = textEncoder.encode(JSON.stringify(payload))
  const frame = new Uint8Array(1 + encoded.length)
  frame[0] = MSG_CONTROL
  frame.set(encoded, 1)
  ws.send(frame)
}
