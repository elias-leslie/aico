'use client'

import type React from 'react'
import { getWsUrl } from '../api-config'
import {
  CONNECTION_TIMEOUT,
  WS_CLIENT_PING_INTERVAL,
  WS_CLOSE_CODE_SESSION_DEAD,
} from '../constants/terminal'

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

/** Who holds the session's one shared size (the server's `size_holder`
 * notice): this view, or the app and device that claimed it last. */
export interface SizeHolderFrame {
  here: boolean
  viewer: { app: string; device: string } | null
}

/** The host a remote session runs on and whether it can be reached (the
 * server's `host_state`): `live`, or why the terminal is covered. */
export interface HostStateFrame {
  host: string
  state: string
}

export interface WebSocketConnectionCallbacks {
  onMessage?: (data: string) => void
  onSizeHolder?: (holder: SizeHolderFrame) => void
  onHostState?: (frame: HostStateFrame) => void
  /** How much history the server's seed carries (sent before the seed). */
  onHistoryLines?: (historyLines: number) => void
  onBeforeReconnectData?: () => void
  onDisconnect?: () => void
  getDimensions?: () => { cols: number; rows: number } | null
  sendInitialResize?: boolean
  setStatus: (status: string) => void
}

// Binary protocol message types (must match backend)
const MSG_OUTPUT = 0x01
const MSG_CONTROL = 0x02

/** Client capabilities advertised in the initial resize message. */
const CLIENT_CAPABILITIES = ['binary_protocol']

const textDecoder = new TextDecoder()
const MAX_RECONNECT_ATTEMPTS = 30
const INITIAL_RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 2000

function getReconnectDelay(attemptIndex: number): number {
  return Math.min(
    INITIAL_RECONNECT_DELAY_MS * 1.5 ** attemptIndex,
    MAX_RECONNECT_DELAY_MS,
  )
}

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
    onMessage,
    onBeforeReconnectData,
    onDisconnect,
    getDimensions,
    sendInitialResize = true,
    setStatus,
  } = callbacks
  // Out of retries, the status alone says so: the terminal area shows the
  // notice for it (components/TerminalNotice.tsx).
  const scheduleReconnect = (exhaustedStatus: string) => {
    if (retryCountRef.current < MAX_RECONNECT_ATTEMPTS) {
      const attempt = retryCountRef.current + 1
      const delay = getReconnectDelay(retryCountRef.current)
      retryCountRef.current = attempt
      setStatus('connecting')
      retryTimeoutRef.current = setTimeout(() => {
        retryTimeoutRef.current = null
        if (mountedRef.current) connectRef.current?.()
      }, delay)
      return
    }

    setStatus(exhaustedStatus)
    onDisconnect?.()
  }

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

  const query = new URLSearchParams()
  if (workingDir) query.set('working_dir', workingDir)
  const queryString = query.toString()
  const wsPath = `/ws/${sessionId}${queryString ? `?${queryString}` : ''}`

  let ws: WebSocket
  try {
    ws = new WebSocket(getWsUrl(wsPath))
    ws.binaryType = 'arraybuffer'
  } catch {
    connectingRef.current = false
    setStatus('error')
    return
  }
  wsRef.current = ws

  // Set up connection timeout with exponential-backoff retry
  timeoutIdRef.current = setTimeout(() => {
    if (wsRef.current !== ws) return
    if (ws.readyState !== WebSocket.CONNECTING) return
    wsRef.current = null
    ws.close()
    if (!mountedRef.current) return
    scheduleReconnect('timeout')
  }, CONNECTION_TIMEOUT)

  ws.onopen = () => {
    if (wsRef.current !== ws) {
      ws.close()
      return
    }
    connectingRef.current = false
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current)
    if (!mountedRef.current) return

    const hadRetries = retryCountRef.current > 0
    retryCountRef.current = 0
    setStatus('connected')

    if (!hasConnectedRef.current) {
      hasConnectedRef.current = true
      if (hadRetries) {
        onBeforeReconnectData?.()
      }
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

    // Negotiate capabilities even when this view must not claim tmux geometry.
    // getDimensions only answers while this view owns resize (active and
    // focused), so a connect-time size is also a claim on the shared window.
    const dims = sendInitialResize ? getDimensions?.() : null
    ws.send(
      JSON.stringify({
        __ctrl: true,
        ...(dims
          ? { resize: { cols: dims.cols, rows: dims.rows }, claim: true }
          : {}),
        capabilities: CLIENT_CAPABILITIES,
      }),
    )
  }

  ws.onmessage = (event) => {
    if (wsRef.current !== ws) return
    if (!mountedRef.current) return
    try {
      // Binary protocol handling
      if (event.data instanceof ArrayBuffer) {
        const view = new Uint8Array(event.data)
        if (view.length < 1) return

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

      // Text frames carry only control messages (the transport notice);
      // output always arrives binary.
      if (typeof event.data === 'string') {
        dispatchControlMessage(event.data, callbacks)
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error)
    }
  }

  ws.onclose = (event) => {
    if (wsRef.current !== ws) return
    wsRef.current = null
    connectingRef.current = false
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current)
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = null
    }
    if (!mountedRef.current) return

    if (event.code !== WS_CLOSE_CODE_SESSION_DEAD) {
      scheduleReconnect('disconnected')
      return
    }
    setStatus('session_dead')
    onDisconnect?.()
  }

  ws.onerror = () => {
    if (wsRef.current !== ws) return
    wsRef.current = null
    connectingRef.current = false
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current)
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = null
    }
    if (!mountedRef.current) return
    if (
      ws.readyState !== WebSocket.CLOSING &&
      ws.readyState !== WebSocket.CLOSED
    ) {
      ws.close()
    }
    scheduleReconnect('error')
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

    if (control.transport === 'control') {
      const historyLines = control.history_lines
      if (typeof historyLines === 'number' && historyLines > 0) {
        callbacks.onHistoryLines?.(historyLines)
      }
      return true
    }

    const holder = control.size_holder as Record<string, unknown> | undefined
    if (
      holder &&
      typeof holder === 'object' &&
      typeof holder.here === 'boolean'
    ) {
      const viewer = holder.viewer as Record<string, unknown> | null | undefined
      callbacks.onSizeHolder?.({
        here: holder.here,
        viewer:
          viewer &&
          typeof viewer.app === 'string' &&
          typeof viewer.device === 'string'
            ? { app: viewer.app, device: viewer.device }
            : null,
      })
      return true
    }

    const hostState = control.host_state as Record<string, unknown> | undefined
    if (
      hostState &&
      typeof hostState === 'object' &&
      typeof hostState.host === 'string' &&
      typeof hostState.state === 'string'
    ) {
      callbacks.onHostState?.({ host: hostState.host, state: hostState.state })
      return true
    }

    // Unknown control frames still belong to the control channel and should
    // never be rendered into the visible terminal buffer.
    return true
  } catch {
    return false
  }
}
