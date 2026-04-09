'use client'

import { clsx } from 'clsx'
import { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import { LineCache } from '../lib/a-term/line-cache'
import {
  A_TERM_THEMES,
  PHOSPHOR_THEME,
  SCROLLBACK,
} from '../lib/constants/a-term'
import { useATermDiagnostics } from '../lib/hooks/use-a-term-diagnostics'
import { useATermHandle } from '../lib/hooks/use-a-term-handle'
import { useATermInstance } from '../lib/hooks/use-a-term-instance'
import { useATermResize } from '../lib/hooks/use-a-term-resize'
import { useATermScrolling } from '../lib/hooks/use-a-term-scrolling'
import { useATermSearch } from '../lib/hooks/use-a-term-search'
import { useATermWebSocket } from '../lib/hooks/use-a-term-websocket'
import { useATermWriteQueue } from '../lib/hooks/use-a-term-write-queue'
import { useBracketedPaste } from '../lib/hooks/use-bracketed-paste'
import { useScrollbackOverlay } from '../lib/hooks/use-scrollback-overlay'
import { useScrollbackPager } from '../lib/hooks/use-scrollback-pager'
import { profileAnsiColors } from '../lib/utils/ansi-color-profile'
import { isMobileDevice } from '../lib/utils/device'
import { isTuiSessionMode } from '../lib/utils/session-mode'
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
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const aTermRef = useRef<XtermATerm | null>(null)
    const fitAddonRef = useRef<XtermFitAddon | null>(null)
    const isFocusedRef = useRef(false)
    const isVisibleRef = useRef(isVisible)
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

    const { enqueueWrite, applySnapshot, resetQueue } = useATermWriteQueue({
      aTermRef,
      isVisibleRef,
      sessionMode,
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

    const { status, wsRef, reconnect, sendInput, connect, disconnect } =
      useATermWebSocket({
        sessionId,
        workingDir,
        sendInitialResize: !suppressSharedResize,
        onStatusChange,
        onDisconnect,
        onBeforeReconnectData: () => {
          resetQueue()
          lineCacheRef.current.reset()
          aTermRef.current?.reset()
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
        onATermMessage: (message) => {
          enqueueWrite(`${message}\r\n`)
        },
        getDimensions: () => fitAddonRef.current?.proposeDimensions() ?? null,
      })

    const { handleViewportInit, handleScrollbackPage } = useScrollbackPager({
      wsRef,
      onWrite: enqueueWrite,
    })
    const overlay = useScrollbackOverlay({ wsRef, sessionMode })
    const { clearSearch, overlaySearchState, search } = useATermSearch({
      aTermRef,
      sessionMode,
      activateOverlay: overlay.activate,
      getOverlayLines: overlay.getCachedLines,
      overlaySearchVersion: overlay.searchVersion,
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

    const pasteInput = useBracketedPaste(sendInput)

    const isMobile = useMemo(() => isMobileDevice(), [])

    const { setupScrolling, resetCopyMode } = useATermScrolling({
      wsRef,
      aTermRef,
      isMobile,
      sessionMode,
      onRequestScrollbackOverlay: overlay.activate,
      isScrollbackOverlayActive: overlay.isActive,
    })

    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally empty deps — reads refs at call time
    const handleATermData = useCallback(
      (data: string) => {
        if (!isFocusedRef.current) return
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          resetCopyMode()
          sendInput(data)
        }
      },
      [resetCopyMode, sendInput],
    )

    // TUI/agent sessions: scrollback overlay handles all history via tmux.
    // Setting scrollback to 0 prevents a duplicate native scrollbar from
    // accumulating live writes alongside the overlay.
    const effectiveScrollback = isTuiSession ? 0 : scrollback

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
        setupScrolling,
      },
      { aTermRef, fitAddonRef, containerRef, isFocusedRef },
    )

    const { handleResize } = useATermResize({
      aTermRef,
      fitAddonRef,
      containerRef,
      wsRef,
      sendBackendResize: !suppressSharedResize,
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
      if (!isVisible || !isReady || status !== 'connected') return
      handleResize()
    }, [handleResize, isReady, isVisible, status])

    return (
      <div
        className={clsx(
          'relative h-full w-full min-h-0 min-w-0 overflow-hidden',
          className,
        )}
      >
        <div
          ref={containerRef}
          className="w-full h-full min-h-0 min-w-0 overflow-hidden"
          style={{ backgroundColor: theme.background }}
        />
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
