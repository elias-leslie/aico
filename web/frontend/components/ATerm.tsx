'use client'

import { clsx } from 'clsx'
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import '@xterm/xterm/css/xterm.css'
import { swallowQueryReplies, trackSgrMouse } from '../lib/a-term/control-view'
import { keepReadingPlace } from '../lib/a-term/reading-place'
import { PHOSPHOR_THEME, SCROLLBACK } from '../lib/constants/a-term'
import type { ATermRendererStatus } from '../lib/hooks/a-term-instance-utils'
import { useATermHandle } from '../lib/hooks/use-a-term-handle'
import { useATermInstance } from '../lib/hooks/use-a-term-instance'
import { useATermResize } from '../lib/hooks/use-a-term-resize'
import { useATermScrolling } from '../lib/hooks/use-a-term-scrolling'
import { useATermSearch } from '../lib/hooks/use-a-term-search'
import { useATermWebSocket } from '../lib/hooks/use-a-term-websocket'
import { useATermWriteQueue } from '../lib/hooks/use-a-term-write-queue'
import { isMobileDevice } from '../lib/utils/device'
import type { ATermHandle, ATermProps } from './a-term.types'
import { ScrollToBottomPill } from './ScrollToBottomPill'

export type {
  ATermHandle,
  ATermProps,
  ConnectionStatus,
} from './a-term.types'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>
type XtermFitAddon = InstanceType<typeof import('@xterm/addon-fit').FitAddon>

function isObserverModeEnabled(search: string): boolean {
  const value = new URLSearchParams(search).get('observer')
  return value === '1' || value === 'true'
}

export const ATermComponent = forwardRef<ATermHandle, ATermProps>(
  function ATermComponent(
    {
      sessionId,
      workingDir,
      className,
      onDisconnect,
      onStatusChange,
      fontSize = 14,
      isVisible = true,
      onFilePaste,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const aTermRef = useRef<XtermATerm | null>(null)
    const fitAddonRef = useRef<XtermFitAddon | null>(null)
    const isFocusedRef = useRef(false)
    const isVisibleRef = useRef(isVisible)
    const rendererStatusRef = useRef<ATermRendererStatus | null>(null)
    const suppressSharedResize = useMemo(
      () =>
        typeof window !== 'undefined' &&
        isObserverModeEnabled(window.location.search),
      [],
    )
    const [isWindowFocused, setIsWindowFocused] = useState(
      () => typeof document === 'undefined' || document.hasFocus(),
    )
    const [isPageVisible, setIsPageVisible] = useState(
      () =>
        typeof document === 'undefined' ||
        document.visibilityState !== 'hidden',
    )
    const ownsResize =
      !suppressSharedResize && isVisible && isWindowFocused && isPageVisible

    useEffect(() => {
      const handleFocus = () => setIsWindowFocused(true)
      const handleBlur = () => setIsWindowFocused(false)
      const handleVisibilityChange = () =>
        setIsPageVisible(document.visibilityState !== 'hidden')
      window.addEventListener('focus', handleFocus)
      window.addEventListener('blur', handleBlur)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      return () => {
        window.removeEventListener('focus', handleFocus)
        window.removeEventListener('blur', handleBlur)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }, [])

    useEffect(() => {
      isVisibleRef.current = isVisible
    }, [isVisible])

    // The backend streams the pane's own output, so this xterm holds the
    // history and the program's real modes. The server says how much history
    // its seed carries (with the transport message, before the seed); null
    // until it has.
    const [controlHistoryLines, setControlHistoryLines] = useState<
      number | null
    >(null)
    const sgrMouseRef = useRef<() => boolean>(() => false)
    const isSgrMouse = useCallback(() => sgrMouseRef.current(), [])

    // The server repaints the whole pane on request; the write queue asks for
    // it once a reader who held the old view is back at the bottom.
    const reseedWsRef = useRef<React.RefObject<WebSocket | null> | null>(null)
    const reseedSource = useMemo(
      () => ({
        available: () =>
          reseedWsRef.current?.current?.readyState === WebSocket.OPEN,
        request: () => {
          reseedWsRef.current?.current?.send(
            JSON.stringify({ __ctrl: true, refresh: true }),
          )
        },
      }),
      [],
    )

    const { enqueueWrite, restartStream, onViewportMoved } = useATermWriteQueue(
      {
        aTermRef,
        isVisibleRef,
        reseed: reseedSource,
      },
    )

    const { status, wsRef, reconnect, sendInput, connect, disconnect } =
      useATermWebSocket({
        sessionId,
        workingDir,
        sendInitialResize: !suppressSharedResize,
        onHistoryLines: (historyLines) => {
          // Size the buffer now, before the seed is written, not on the
          // next render.
          if (aTermRef.current)
            aTermRef.current.options.scrollback = historyLines
          setControlHistoryLines(historyLines)
        },
        onStatusChange,
        onDisconnect,
        onBeforeReconnectData: restartStream,
        onMessage: (data) => {
          if (!aTermRef.current) return
          enqueueWrite(data)
        },
        onATermMessage: (message) => {
          enqueueWrite(`${message}\r\n`)
        },
        getDimensions: () =>
          ownsResize
            ? (fitAddonRef.current?.proposeDimensions() ?? null)
            : null,
      })

    useEffect(() => {
      reseedWsRef.current = wsRef
    }, [wsRef])

    const sendRendererStatus = useCallback(
      (rendererStatus: ATermRendererStatus) => {
        rendererStatusRef.current = rendererStatus
        if (wsRef.current?.readyState !== WebSocket.OPEN) return
        wsRef.current.send(
          JSON.stringify({
            __ctrl: true,
            renderer_status: rendererStatus,
          }),
        )
      },
      [wsRef],
    )

    useEffect(() => {
      if (status !== 'connected') return
      const rendererStatus = rendererStatusRef.current
      if (!rendererStatus) return
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      wsRef.current.send(
        JSON.stringify({
          __ctrl: true,
          renderer_status: rendererStatus,
        }),
      )
    }, [status, wsRef])

    const { clearSearch, search } = useATermSearch({ aTermRef })

    // Paste goes through tmux, which brackets the text only when the program
    // enabled bracketed paste.
    const pasteInput = useCallback(
      (data: string) => {
        const text = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        if (text && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ __ctrl: true, paste: text }))
        }
        return Promise.resolve()
      },
      [wsRef],
    )
    const pasteFile = useCallback(
      (file: File) => {
        void onFilePaste?.(file, sessionId)
      },
      [onFilePaste, sessionId],
    )

    const isMobile = useMemo(() => isMobileDevice(), [])

    const { setupScrolling } = useATermScrolling({
      wsRef,
      aTermRef,
      isMobile,
      isSgrMouse,
    })

    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally empty deps — reads refs at call time
    const handleATermData = useCallback(
      (data: string) => {
        if (!isFocusedRef.current) return
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          sendInput(data)
        }
      },
      [sendInput],
    )

    const { isReady } = useATermInstance(
      {
        fontSize,
        scrollback: controlHistoryLines ?? SCROLLBACK,
        onData: handleATermData,
        onPaste: pasteInput,
        onFilePaste: pasteFile,
        onRendererStatus: sendRendererStatus,
        setupScrolling,
      },
      { aTermRef, fitAddonRef, containerRef, isFocusedRef },
    )

    useEffect(() => {
      const term = aTermRef.current
      if (!isReady || !term) return
      const sgr = trackSgrMouse(term)
      sgrMouseRef.current = sgr.isSgr
      const stopSwallowing = swallowQueryReplies(term)
      const scrolled = term.onScroll(onViewportMoved)
      const readingPlace = keepReadingPlace(term)
      return () => {
        readingPlace.dispose()
        sgr.dispose()
        stopSwallowing()
        scrolled.dispose()
        sgrMouseRef.current = () => false
      }
    }, [isReady, onViewportMoved])

    const { handleResize } = useATermResize({
      aTermRef,
      fitAddonRef,
      containerRef,
      wsRef,
      sendBackendResize: ownsResize,
    })

    useATermHandle(ref, {
      reconnect,
      sendInput,
      status,
      aTermRef,
      search,
      clearSearch,
    })

    useEffect(() => {
      if (isVisible && isReady) {
        connect()
        return
      }
      disconnect()
    }, [connect, disconnect, isReady, isVisible])

    useEffect(() => {
      if (!ownsResize || !isReady || status !== 'connected') return
      handleResize()
    }, [handleResize, isReady, ownsResize, status])

    return (
      <div
        className={clsx(
          'relative h-full w-full min-h-0 min-w-0 overflow-hidden',
          className,
        )}
      >
        <div
          ref={containerRef}
          data-testid="a-term-live-container"
          className="h-full min-h-0 min-w-0 overflow-hidden"
          style={{
            backgroundColor: PHOSPHOR_THEME.background,
            width: '100%',
          }}
        />
        <ScrollToBottomPill aTermRef={aTermRef} isReady={isReady} />
      </div>
    )
  },
)
