'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionStatus } from '../../components/Terminal'
import {
  type HostStateFrame,
  openWebSocketConnection,
  type SizeHolderFrame,
} from './use-websocket-connection'

/** How long a socket that looks open may stay silent after the app returns
 * to the foreground before it is replaced. */
const RESUME_PROBE_MS = 2_500

interface UseTerminalWebSocketOptions {
  sessionId: string
  workingDir?: string
  sendInitialResize?: boolean
  /** Called when connection status changes */
  onStatusChange?: (status: ConnectionStatus) => void
  /** Called when the WebSocket disconnects */
  onDisconnect?: () => void
  /** Called when data is received from the server */
  onMessage?: (data: string) => void
  /** Called when the server says who holds the shared size */
  onSizeHolder?: (holder: SizeHolderFrame) => void
  /** Called when the server says whether a remote session's host can be reached */
  onHostState?: (frame: HostStateFrame) => void
  /** Called with how much history the server's seed carries (sent before the seed) */
  onHistoryLines?: (historyLines: number) => void
  /** Called before reconnect data arrives — clear terminal buffer to prevent duplicates */
  onBeforeReconnectData?: () => void
  /** Get current terminal dimensions for resize message */
  getDimensions?: () => { cols: number; rows: number } | null
}

interface UseTerminalWebSocketReturn {
  /** Current connection status */
  status: ConnectionStatus
  /** WebSocket ref for external access (sending data) */
  wsRef: React.RefObject<WebSocket | null>
  /** Manually reconnect */
  reconnect: () => void
  /** Send data to the server */
  sendInput: (data: string) => void
  /** Connect to WebSocket (called by terminal init) */
  connect: () => void
  /** Disconnect from WebSocket */
  disconnect: () => void
}

/**
 * Hook for managing WebSocket connection to terminal backend.
 *
 * Handles:
 * - Connection with timeout and exponential-backoff retry (up to 10 attempts)
 * - Status tracking (connecting, connected, disconnected, error, session_dead, timeout)
 * - Message forwarding
 *
 * Connection logic lives in use-websocket-connection.ts.
 */
export function useTerminalWebSocket({
  sessionId,
  workingDir,
  sendInitialResize = true,
  onStatusChange,
  onDisconnect,
  onMessage,
  onSizeHolder,
  onHostState,
  onHistoryLines,
  onBeforeReconnectData,
  getDimensions,
}: UseTerminalWebSocketOptions): UseTerminalWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const retryCountRef = useRef(0)
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const connectRef = useRef<(() => void) | undefined>(undefined)
  const connectingRef = useRef(false)
  const hasConnectedRef = useRef(false)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Store callbacks in refs to avoid re-render loops
  const onStatusChangeRef = useRef(onStatusChange)
  const onDisconnectRef = useRef(onDisconnect)
  const onMessageRef = useRef(onMessage)
  const onSizeHolderRef = useRef(onSizeHolder)
  const onHostStateRef = useRef(onHostState)
  const onHistoryLinesRef = useRef(onHistoryLines)
  const onBeforeReconnectDataRef = useRef(onBeforeReconnectData)
  const getDimensionsRef = useRef(getDimensions)

  // Update callback refs when they change
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
    onDisconnectRef.current = onDisconnect
    onMessageRef.current = onMessage
    onSizeHolderRef.current = onSizeHolder
    onHostStateRef.current = onHostState
    onHistoryLinesRef.current = onHistoryLines
    onBeforeReconnectDataRef.current = onBeforeReconnectData
    getDimensionsRef.current = getDimensions
  }, [
    onStatusChange,
    onDisconnect,
    onMessage,
    onSizeHolder,
    onHostState,
    onHistoryLines,
    onBeforeReconnectData,
    getDimensions,
  ])

  // Notify parent of status changes
  useEffect(() => {
    onStatusChangeRef.current?.(status)
  }, [status])

  // Track mounted state for cleanup
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const connect = useCallback(() => {
    if (connectingRef.current) return
    connectingRef.current = true

    openWebSocketConnection(
      sessionId,
      workingDir,
      {
        wsRef,
        mountedRef,
        connectingRef,
        hasConnectedRef,
        retryCountRef,
        timeoutIdRef,
        retryTimeoutRef,
        pingIntervalRef,
        connectRef,
      },
      {
        onSizeHolder: (holder) => onSizeHolderRef.current?.(holder),
        onHostState: (frame) => onHostStateRef.current?.(frame),
        onMessage: (data) => onMessageRef.current?.(data),
        onHistoryLines: (historyLines) =>
          onHistoryLinesRef.current?.(historyLines),
        onBeforeReconnectData: () => onBeforeReconnectDataRef.current?.(),
        onDisconnect: () => onDisconnectRef.current?.(),
        getDimensions: () => getDimensionsRef.current?.() ?? null,
        sendInitialResize,
        setStatus: (s) => setStatus(s as ConnectionStatus),
      },
    )
  }, [sendInitialResize, sessionId, workingDir])

  // Keep ref in sync for recursive timeout calls
  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const disconnect = useCallback(() => {
    connectingRef.current = false
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
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  const reconnect = useCallback(() => {
    disconnect()
    retryCountRef.current = 0
    setStatus('connecting')
    connect()
  }, [connect, disconnect])

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])

  // Auto-reconnect when page becomes visible (mobile resume from sleep)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (!mountedRef.current) return
      const ws = wsRef.current
      if (
        !ws ||
        ws.readyState === WebSocket.CLOSED ||
        ws.readyState === WebSocket.CLOSING
      ) {
        reconnect()
        return
      }
      if (ws.readyState !== WebSocket.OPEN) return
      // A socket can look open after the phone slept and still be dead:
      // ask the server for a word, and replace the socket if none comes.
      let heard = false
      const listener = () => {
        heard = true
      }
      ws.addEventListener('message', listener)
      ws.send(JSON.stringify({ __ctrl: true, ping: true, probe: true }))
      setTimeout(() => {
        ws.removeEventListener('message', listener)
        if (!heard && mountedRef.current && wsRef.current === ws) reconnect()
      }, RESUME_PROBE_MS)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [reconnect])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect()
    }
  }, [disconnect])

  return { status, wsRef, reconnect, sendInput, connect, disconnect }
}
