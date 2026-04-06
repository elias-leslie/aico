'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionStatus } from '../../components/ATerm'
import type { ScrollbackDelta } from '../a-term/line-cache'
import { openWebSocketConnection } from './use-websocket-connection'

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
  /** Called when a-term should display a message */
  onATermMessage?: (message: string) => void
  /** Called when backend sends an authoritative scrollback snapshot */
  onScrollbackSync?: (
    scrollback: string,
    cursorPosition?: { x: number; y: number },
  ) => void
  /** Called when backend sends a scrollback delta (Phase 2) */
  onScrollbackDelta?: (delta: ScrollbackDelta) => void
  /** Called when backend sends viewport init for instant render (Phase 3) */
  onViewportInit?: (data: {
    lines: string
    cursor_position?: { x: number; y: number }
    total_lines: number
    viewport_start_line: number
  }) => void
  /** Called when backend sends a scrollback page response (Phase 3) */
  onScrollbackPage?: (data: {
    from_line: number
    lines: string[]
    total_lines: number
  }) => void
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
  onATermMessage,
  onScrollbackSync,
  onScrollbackDelta,
  onViewportInit,
  onScrollbackPage,
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
  const onATermMessageRef = useRef(onATermMessage)
  const onScrollbackSyncRef = useRef(onScrollbackSync)
  const onScrollbackDeltaRef = useRef(onScrollbackDelta)
  const onViewportInitRef = useRef(onViewportInit)
  const onScrollbackPageRef = useRef(onScrollbackPage)
  const onBeforeReconnectDataRef = useRef(onBeforeReconnectData)
  const getDimensionsRef = useRef(getDimensions)

  // Update callback refs when they change
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
    onDisconnectRef.current = onDisconnect
    onMessageRef.current = onMessage
    onATermMessageRef.current = onATermMessage
    onScrollbackSyncRef.current = onScrollbackSync
    onScrollbackDeltaRef.current = onScrollbackDelta
    onViewportInitRef.current = onViewportInit
    onScrollbackPageRef.current = onScrollbackPage
    onBeforeReconnectDataRef.current = onBeforeReconnectData
    getDimensionsRef.current = getDimensions
  }, [onStatusChange, onDisconnect, onMessage, onATermMessage, onScrollbackSync, onScrollbackDelta, onViewportInit, onScrollbackPage, onBeforeReconnectData, getDimensions])

  // Notify parent of status changes
  useEffect(() => {
    onStatusChangeRef.current?.(status)
  }, [status])

  // Track mounted state for cleanup
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const connect = useCallback(() => {
    if (connectingRef.current) return
    connectingRef.current = true

    openWebSocketConnection(sessionId, workingDir, {
      wsRef,
      mountedRef,
      connectingRef,
      hasConnectedRef,
      retryCountRef,
      timeoutIdRef,
      retryTimeoutRef,
      pingIntervalRef,
      connectRef,
    }, {
      onATermMessage: (msg) => onATermMessageRef.current?.(msg),
      onMessage: (data) => onMessageRef.current?.(data),
      onScrollbackSync: (scrollback, cursorPosition) =>
        onScrollbackSyncRef.current?.(scrollback, cursorPosition),
      onScrollbackDelta: (delta) =>
        onScrollbackDeltaRef.current?.(delta),
      onViewportInit: (data) =>
        onViewportInitRef.current?.(data),
      onScrollbackPage: (data) =>
        onScrollbackPageRef.current?.(data),
      onBeforeReconnectData: () => onBeforeReconnectDataRef.current?.(),
      onDisconnect: () => onDisconnectRef.current?.(),
      getDimensions: () => getDimensionsRef.current?.() ?? null,
      sendInitialResize,
      setStatus: (s) => setStatus(s as ConnectionStatus),
    })
  }, [sendInitialResize, sessionId, workingDir])

  // Keep ref in sync for recursive timeout calls
  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const disconnect = useCallback(() => {
    connectingRef.current = false
    if (timeoutIdRef.current) { clearTimeout(timeoutIdRef.current); timeoutIdRef.current = null }
    if (retryTimeoutRef.current) { clearTimeout(retryTimeoutRef.current); retryTimeoutRef.current = null }
    if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
  }, [])

  const reconnect = useCallback(() => {
    disconnect()
    retryCountRef.current = 0
    onATermMessageRef.current?.('\x1b[33mReconnecting...\x1b[0m')
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
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnect()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [reconnect])

  // Cleanup on unmount
  useEffect(() => { return () => { disconnect() } }, [disconnect])

  return { status, wsRef, reconnect, sendInput, connect, disconnect }
}
