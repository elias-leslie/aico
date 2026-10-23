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
import { LineCache } from '../lib/a-term/line-cache'
import {
  A_TERM_THEMES,
  PHOSPHOR_THEME,
  SCROLLBACK,
} from '../lib/constants/a-term'
import type { ATermRendererStatus } from '../lib/hooks/a-term-instance-utils'
import { useATermDiagnostics } from '../lib/hooks/use-a-term-diagnostics'
import { useATermHandle } from '../lib/hooks/use-a-term-handle'
import { useATermInstance } from '../lib/hooks/use-a-term-instance'
import { useATermResize } from '../lib/hooks/use-a-term-resize'
import { useATermScrolling } from '../lib/hooks/use-a-term-scrolling'
import { useATermSearch } from '../lib/hooks/use-a-term-search'
import { useATermWebSocket } from '../lib/hooks/use-a-term-websocket'
import { useATermWriteQueue } from '../lib/hooks/use-a-term-write-queue'
import { useBracketedPaste } from '../lib/hooks/use-bracketed-paste'
import { usePaneMode } from '../lib/hooks/use-pane-mode'
import { useScrollbackOverlay } from '../lib/hooks/use-scrollback-overlay'
import { useScrollbackPager } from '../lib/hooks/use-scrollback-pager'
import { profileAnsiColors } from '../lib/utils/ansi-color-profile'
import { isMobileDevice } from '../lib/utils/device'
import { isTuiSessionMode } from '../lib/utils/session-mode'
import { requestedTransport } from '../lib/utils/terminal-transport'
import { ATermDiagnosticsOverlay } from './ATermDiagnosticsOverlay'
import type { ATermHandle, ATermProps } from './a-term.types'
import { ScrollbackOverlay } from './ScrollbackOverlay'

export type {
  ATermHandle,
  ATermProps,
  ConnectionStatus,
} from './a-term.types'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>
type XtermFitAddon = InstanceType<typeof import('@xterm/addon-fit').FitAddon>

function inferThemeId(theme: NonNullable<ATermProps['theme']>): string {
  for (const [themeId, candidate] of Object.entries(A_TERM_THEMES)) {
    if (
      candidate.theme.background === theme.background &&
      candidate.theme.foreground === theme.foreground &&
      candidate.theme.red === theme.red &&
      candidate.theme.green === theme.green &&
      candidate.theme.brightRed === theme.brightRed &&
      candidate.theme.brightGreen === theme.brightGreen
    ) {
      return themeId
    }
  }
  return 'custom'
}

function isObserverModeEnabled(search: string): boolean {
  const value = new URLSearchParams(search).get('observer')
  return value === '1' || value === 'true'
}

// xterm's FitAddon subtracts 14px from available width whenever scrollback is
// enabled. Our TUI overlay uses scrollback, while the live TUI terminal keeps
// scrollback at 0 to avoid duplicate native history. Reserve the same rail in
// the live view so opening the overlay does not suddenly drop columns.
const TUI_SCROLLBAR_RAIL_WIDTH_PX = 14

export const ATermComponent = forwardRef<ATermHandle, ATermProps>(
  function ATermComponent(
    {
      sessionId,
      sessionMode,
      workingDir,
      className,
      onDisconnect,
      onStatusChange,
      fontFamily = "'JetBrains Mono', monospace",
      fontSize = 14,
      scrollback = SCROLLBACK,
      cursorStyle = 'block',
      cursorBlink = true,
      theme = PHOSPHOR_THEME,
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
    const diagnostics = useATermDiagnostics(sessionId)
    const recordDiagnostic = diagnostics.record
    const getDiagnostics = diagnostics.getDiagnostics
    const diagnosticsEnabled = diagnostics.enabled
    const incrementDiagnosticCounter = diagnostics.incrementCounter
    const inferredThemeId = useMemo(() => inferThemeId(theme), [theme])
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

    useEffect(() => {
      recordDiagnostic('theme_applied', {
        themeId: inferredThemeId,
        red: theme.red,
        green: theme.green,
        brightRed: theme.brightRed,
        brightGreen: theme.brightGreen,
      })
    }, [
      inferredThemeId,
      recordDiagnostic,
      theme.brightGreen,
      theme.brightRed,
      theme.green,
      theme.red,
    ])

    const lineCacheRef = useRef(new LineCache())
    const isTuiSession = isTuiSessionMode(sessionMode)

    // Control mode (the default): the backend streams the pane's own output,
    // so this xterm holds the history and the program's real modes, and the
    // classic overlay, pane-mode queries and snapshots stay out of the way.
    // The server confirms the transport on connect and may refuse it.
    const [requestControl] = useState(() => requestedTransport() === 'control')
    const [controlMode, setControlMode] = useState(requestControl)
    const controlModeRef = useRef(controlMode)
    // How much history the server's control-mode seed carries (it says so
    // with the transport, before the seed); null until it has.
    const [controlHistoryLines, setControlHistoryLines] = useState<
      number | null
    >(null)
    const sgrMouseRef = useRef<() => boolean>(() => false)
    const isSgrMouse = useCallback(() => sgrMouseRef.current(), [])
    const classicSessionMode = controlMode ? undefined : sessionMode

    // The control-mode server repaints the whole pane on request; the write
    // queue asks for it once a reader who held the old view is back at the
    // bottom.
    const reseedWsRef = useRef<React.RefObject<WebSocket | null> | null>(null)
    const reseedSource = useMemo(
      () => ({
        available: () =>
          controlModeRef.current &&
          reseedWsRef.current?.current?.readyState === WebSocket.OPEN,
        request: () => {
          reseedWsRef.current?.current?.send(
            JSON.stringify({ __ctrl: true, refresh: true }),
          )
        },
      }),
      [],
    )

    const { enqueueWrite, applySnapshot, restartStream, onViewportMoved } =
      useATermWriteQueue({
        aTermRef,
        isVisibleRef,
        sessionMode: classicSessionMode,
        reseed: reseedSource,
        diagnostics: {
          enabled: diagnosticsEnabled,
          incrementCounter: incrementDiagnosticCounter,
          record: recordDiagnostic,
        },
      })

    // Refs for pager/overlay callbacks — breaks circular dep between WebSocket and consumer hooks
    const viewportInitRef = useRef<
      | ((
          data: Parameters<
            NonNullable<
              Parameters<typeof useATermWebSocket>[0]['onViewportInit']
            >
          >[0],
        ) => void)
      | null
    >(null)
    const scrollbackPageRef = useRef<
      | ((
          data: Parameters<
            NonNullable<
              Parameters<typeof useATermWebSocket>[0]['onScrollbackPage']
            >
          >[0],
        ) => void)
      | null
    >(null)
    const overlayPageRef = useRef<
      | ((
          data: Parameters<
            NonNullable<
              Parameters<typeof useATermWebSocket>[0]['onScrollbackPage']
            >
          >[0],
        ) => void)
      | null
    >(null)
    const overlayCacheUpdateRef = useRef<((scrollback: string) => void) | null>(
      null,
    )
    const paneModeRef = useRef<
      | ((
          data: Parameters<
            NonNullable<Parameters<typeof useATermWebSocket>[0]['onPaneMode']>
          >[0],
        ) => void)
      | null
    >(null)

    const { status, wsRef, reconnect, sendInput, connect, disconnect } =
      useATermWebSocket({
        sessionId,
        workingDir,
        sendInitialResize: !suppressSharedResize,
        requestControl,
        onTransport: (transport, historyLines) => {
          const on = transport === 'control'
          controlModeRef.current = on
          setControlMode(on)
          if (on && historyLines) {
            // Size the buffer now, before the seed is written, not on the
            // next render.
            if (aTermRef.current)
              aTermRef.current.options.scrollback = historyLines
            setControlHistoryLines(historyLines)
          }
        },
        onStatusChange,
        onDisconnect,
        onBeforeReconnectData: () => {
          lineCacheRef.current.reset()
          restartStream()
        },
        onMessage: (data) => {
          if (!aTermRef.current) return
          if (diagnosticsEnabled) {
            const profile = profileAnsiColors(data)
            if (profile.hasColor) {
              recordDiagnostic('live_write_color_profile', {
                chars: data.length,
                profile,
              })
            }
          }
          enqueueWrite(data)
        },
        onScrollbackSync: (scrollback, cursorPosition) => {
          incrementDiagnosticCounter('snapshotReceived')
          if (diagnosticsEnabled) {
            recordDiagnostic('scrollback_sync_color_profile', {
              chars: scrollback.length,
              profile: profileAnsiColors(scrollback),
            })
          }
          // Full sync resets the line cache so delta tracking restarts clean
          lineCacheRef.current.reset()
          // For TUI sessions, applySnapshot is a no-op — feed the overlay
          // cache instead so scroll-up history stays current.
          overlayCacheUpdateRef.current?.(scrollback)
          applySnapshot(scrollback, cursorPosition)
        },
        onScrollbackDelta: (delta) => {
          if (!lineCacheRef.current.applyDelta(delta)) return
          const content = lineCacheRef.current.toFullContent()
          if (!content) return

          const cursorPosition = delta.cursor
            ? { x: delta.cursor[0], y: delta.cursor[1] }
            : undefined

          if (isTuiSession) {
            overlayCacheUpdateRef.current?.(content)
            return
          }

          applySnapshot(content, cursorPosition)
        },
        onViewportInit: (data) => viewportInitRef.current?.(data),
        onScrollbackPage: (data) => {
          overlayPageRef.current?.(data)
          scrollbackPageRef.current?.(data)
        },
        onPaneMode: (data) => paneModeRef.current?.(data),
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
        recordDiagnostic('renderer_status', { ...rendererStatus })
        if (wsRef.current?.readyState !== WebSocket.OPEN) return
        wsRef.current.send(
          JSON.stringify({
            __ctrl: true,
            renderer_status: rendererStatus,
          }),
        )
      },
      [recordDiagnostic, wsRef],
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

    const { handleViewportInit, handleScrollbackPage } = useScrollbackPager({
      wsRef,
      onWrite: enqueueWrite,
    })
    const overlay = useScrollbackOverlay({ wsRef, sessionMode })
    const { clearSearch, overlaySearchState, search } = useATermSearch({
      aTermRef,
      sessionMode: classicSessionMode,
      activateOverlay: overlay.activate,
      getOverlayLines: overlay.getCachedLines,
      overlaySearchVersion: overlay.searchVersion,
      setOverlaySearchActive: overlay.setSearchActive,
    })
    useEffect(() => {
      viewportInitRef.current = handleViewportInit
      scrollbackPageRef.current = handleScrollbackPage
      overlayPageRef.current = overlay.handleScrollbackPage
      overlayCacheUpdateRef.current = overlay.updateCacheFromSync
    }, [
      handleViewportInit,
      handleScrollbackPage,
      overlay.handleScrollbackPage,
      overlay.updateCacheFromSync,
    ])

    // Any user input returns the pane to the live view. The scrollback overlay
    // covers the live terminal, so without this a keystroke typed while the
    // overlay is open lands in the session with nothing on screen to show for
    // it — the pane looks like it stopped accepting input.
    const overlayActiveRef = useRef(false)
    const deactivateOverlay = overlay.deactivate
    useEffect(() => {
      overlayActiveRef.current = overlay.isActive
    }, [overlay.isActive])

    const sendUserInput = useCallback(
      (data: string) => {
        if (overlayActiveRef.current) {
          overlayActiveRef.current = false
          deactivateOverlay()
        }
        sendInput(data)
      },
      [deactivateOverlay, sendInput],
    )

    const bracketedPaste = useBracketedPaste(sendUserInput)
    // Control mode pastes through tmux, which brackets the text only when the
    // program enabled bracketed paste.
    const pasteInput = useCallback(
      (data: string) => {
        if (!controlModeRef.current) return bracketedPaste(data)
        const text = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        if (text && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ __ctrl: true, paste: text }))
        }
        return Promise.resolve()
      },
      [bracketedPaste, wsRef],
    )
    const pasteFile = useCallback(
      (file: File) => {
        void onFilePaste?.(file, sessionId)
      },
      [onFilePaste, sessionId],
    )

    const isMobile = useMemo(() => isMobileDevice(), [])

    const { handlePaneMode, requestPaneMode, paneOwnsScrollback } =
      usePaneMode(wsRef)

    useEffect(() => {
      paneModeRef.current = handlePaneMode
    }, [handlePaneMode])

    const { setupScrolling } = useATermScrolling({
      wsRef,
      aTermRef,
      isMobile,
      sessionMode: classicSessionMode,
      onRequestScrollbackOverlay: controlMode ? undefined : overlay.activate,
      isScrollbackOverlayActive: overlay.isActive,
      paneOwnsScrollback: controlMode ? undefined : paneOwnsScrollback,
      requestPaneMode: controlMode ? undefined : requestPaneMode,
      controlMode,
      isSgrMouse,
    })

    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally empty deps — reads refs at call time
    const handleATermData = useCallback(
      (data: string) => {
        if (!isFocusedRef.current) return
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          sendUserInput(data)
        }
      },
      [sendUserInput],
    )

    // TUI/agent sessions: scrollback overlay handles all history via tmux.
    // Setting scrollback to 0 prevents a duplicate native scrollbar from
    // accumulating live writes alongside the overlay.
    // Control mode: the pane's own history, as many lines as the seed carries
    // (the user's setting until the server has said).
    const effectiveScrollback = controlMode
      ? (controlHistoryLines ?? scrollback)
      : isTuiSession
        ? 0
        : scrollback
    const showScrollbarRail = isTuiSession && !controlMode

    const { isReady } = useATermInstance(
      {
        cursorBlink,
        cursorStyle,
        fontSize,
        fontFamily,
        scrollback: effectiveScrollback,
        theme,
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
      const stopSwallowing = swallowQueryReplies(
        term,
        () => controlModeRef.current,
      )
      const scrolled = term.onScroll(onViewportMoved)
      return () => {
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
      sendInput: sendUserInput,
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
            backgroundColor: theme.background,
            width: showScrollbarRail
              ? `calc(100% - ${TUI_SCROLLBAR_RAIL_WIDTH_PX}px)`
              : '100%',
          }}
        />
        {showScrollbarRail && (
          <div
            data-testid="a-term-scrollbar-rail"
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: `${TUI_SCROLLBAR_RAIL_WIDTH_PX}px`,
              backgroundColor: theme.background,
              borderLeft: `1px solid ${theme.brightBlack}26`,
              pointerEvents: 'none',
            }}
          />
        )}
        {!controlMode && (
          <ScrollbackOverlay
            isActive={overlay.isActive}
            lines={overlay.lines}
            totalLines={overlay.totalLines}
            isLoading={overlay.isLoading}
            initialScrollLineDelta={overlay.initialScrollLineDelta}
            searchQuery={overlaySearchState?.query ?? ''}
            searchActiveIndex={overlaySearchState?.activeIndex ?? -1}
            onDismiss={overlay.deactivate}
            theme={theme}
            fontFamily={fontFamily}
            fontSize={fontSize}
          />
        )}
        <ATermDiagnosticsOverlay
          enabled={diagnosticsEnabled}
          themeId={inferredThemeId}
          sessionMode={sessionMode}
          getDiagnostics={getDiagnostics}
        />
      </div>
    )
  },
)
