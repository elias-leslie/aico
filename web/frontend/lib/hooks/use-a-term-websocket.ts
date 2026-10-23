'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionStatus } from '../../components/ATerm'
import {
  openWebSocketConnection,
  type SizeHolderFrame,
} from './use-websocket-connection'

interface UseATermWebSocketOptions {
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
  /** Called with how much history the server's seed carries (sent before the seed) */
  onHistoryLines?: (historyLines: number) => void
  /** Called before reconnect data arrives — clear aTerm buffer to prevent duplicates */
  onBeforeReconnectData?: () => void
  /** Get current aTerm dimensions for resize message */
  getDimensions?: () => { cols: number; rows: number } | null
}

interface UseATermWebSocketReturn {
  /** Current connection status */
  status: ConnectionStatus
  /** WebSocket ref for external access (sending data) */
  wsRef: React.RefObject<WebSocket | null>
  /** Manually reconnect */
  reconnect: () => void
  /** Send data to the server */
  sendInput: (data: string) => void
  /** Connect to WebSocket (called by aTerm init) */
  connect: () => void
  /** Disconnect from WebSocket */
  disconnect: () => void
}

/**
 * Hook for managing WebSocket connection to aTerm backend.
 *
 * Handles:
 * - Connection with timeout and exponential-backoff retry (up to 10 attempts)
 * - Status tracking (connecting, connected, disconnected, error, session_dead, timeout)
 * - Message forwarding
 *
 * Connection logic lives in use-websocket-connection.ts.
 */
export function useATermWebSocket({
  sessionId,
  workingDir,
  sendInitialResize = true,
  onStatusChange,
  onDisconnect,
  onMessage,
  onSizeHolder,
  onHistoryLines,
  onBeforeReconnectData,
  getDimensions,
}: UseATermWebSocketOptions): UseATermWebSocketReturn {
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
  const onHistoryLinesRef = useRef(onHistoryLines)
  const onBeforeReconnectDataRef = useRef(onBeforeReconnectData)
  const getDimensionsRef = useRef(getDimensions)

  // Update callback refs when they change
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
    onDisconnectRef.current = onDisconnect
    onMessageRef.current = onMessage
    onSizeHolderRef.current = onSizeHolder
    onHistoryLinesRef.current = onHistoryLines
    onBeforeReconnectDataRef.current = onBeforeReconnectData
    getDimensionsRef.current = getDimensions
  }, [
    onStatusChange,
    onDisconnect,
    onMessage,
    onSizeHolder,
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
      }
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
