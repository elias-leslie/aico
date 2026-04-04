'use client'

import { clsx } from 'clsx'
import { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import {
  PHOSPHOR_THEME,
  SCROLLBACK,
  TERMINAL_THEMES,
} from '../lib/constants/terminal'
import { useBracketedPaste } from '../lib/hooks/use-bracketed-paste'
import { useTerminalDiagnostics } from '../lib/hooks/use-terminal-diagnostics'
import { useScrollbackOverlay } from '../lib/hooks/use-scrollback-overlay'
import { useScrollbackPager } from '../lib/hooks/use-scrollback-pager'
import { useTerminalHandle } from '../lib/hooks/use-terminal-handle'
import { useTerminalInstance } from '../lib/hooks/use-terminal-instance'
import { useTerminalResize } from '../lib/hooks/use-terminal-resize'
import { useTerminalSearch } from '../lib/hooks/use-terminal-search'
import { useTerminalScrolling } from '../lib/hooks/use-terminal-scrolling'
import { useTerminalWebSocket } from '../lib/hooks/use-terminal-websocket'
import { useTerminalWriteQueue } from '../lib/hooks/use-terminal-write-queue'
import { LineCache } from '../lib/terminal/line-cache'
import {
  profileAnsiColors,
} from '../lib/utils/ansi-color-profile'
import { isMobileDevice } from '../lib/utils/device'
import { isTuiSessionMode } from '../lib/utils/session-mode'
import { ScrollbackOverlay } from './ScrollbackOverlay'
import { TerminalDiagnosticsOverlay } from './TerminalDiagnosticsOverlay'
import type { TerminalHandle, TerminalProps } from './terminal.types'

export type {
  ConnectionStatus,
  TerminalHandle,
  TerminalProps,
} from './terminal.types'

// Dynamic imports for xterm (client-side only)
let Terminal: typeof import('@xterm/xterm').Terminal
let FitAddon: typeof import('@xterm/addon-fit').FitAddon

function inferThemeId(
  theme: NonNullable<TerminalProps['theme']>,
): string {
  for (const [themeId, candidate] of Object.entries(TERMINAL_THEMES)) {
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

export const TerminalComponent = forwardRef<TerminalHandle, TerminalProps>(
  function TerminalComponent(
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
    const terminalRef = useRef<InstanceType<typeof Terminal> | null>(null)
    const fitAddonRef = useRef<InstanceType<typeof FitAddon> | null>(null)
    const isFocusedRef = useRef(false)
    const isVisibleRef = useRef(isVisible)
    const diagnostics = useTerminalDiagnostics(sessionId)
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

    const { enqueueWrite, applySnapshot, resetQueue } = useTerminalWriteQueue({
      terminalRef,
      isVisibleRef,
      sessionMode,
      diagnostics: {
        enabled: diagnosticsEnabled,
        incrementCounter: incrementDiagnosticCounter,
        record: recordDiagnostic,
      },
    })

    // Refs for pager/overlay callbacks — breaks circular dep between WebSocket and consumer hooks
    const viewportInitRef =
      useRef<((data: Parameters<NonNullable<Parameters<typeof useTerminalWebSocket>[0]['onViewportInit']>>[0]) => void) | null>(null)
    const scrollbackPageRef =
      useRef<((data: Parameters<NonNullable<Parameters<typeof useTerminalWebSocket>[0]['onScrollbackPage']>>[0]) => void) | null>(null)
    const overlayPageRef =
      useRef<((data: Parameters<NonNullable<Parameters<typeof useTerminalWebSocket>[0]['onScrollbackPage']>>[0]) => void) | null>(null)
    const overlayCacheUpdateRef = useRef<((scrollback: string) => void) | null>(null)

    const { status, wsRef, reconnect, sendInput, connect, disconnect } =
      useTerminalWebSocket({
        sessionId,
        workingDir,
        sendInitialResize: !suppressSharedResize,
        onStatusChange,
        onDisconnect,
        onBeforeReconnectData: () => {
          resetQueue()
          lineCacheRef.current.reset()
          terminalRef.current?.reset()
        },
        onMessage: (data) => {
          if (!terminalRef.current) return
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
        onTerminalMessage: (message) => {
          enqueueWrite(`${message}\r\n`)
        },
        getDimensions: () => fitAddonRef.current?.proposeDimensions() ?? null,
      })

    const { handleViewportInit, handleScrollbackPage } = useScrollbackPager({
      wsRef,
      onWrite: enqueueWrite,
    })
    const overlay = useScrollbackOverlay({ wsRef, sessionMode })
    const { clearSearch, overlaySearchMatch, search } = useTerminalSearch({
      terminalRef,
      sessionMode,
      activateOverlay: overlay.activate,
      getOverlayLines: overlay.getCachedLines,
    })
    useEffect(() => {
      viewportInitRef.current = handleViewportInit
      scrollbackPageRef.current = handleScrollbackPage
      overlayPageRef.current = overlay.handleScrollbackPage
      overlayCacheUpdateRef.current = overlay.updateCacheFromSync
    }, [handleViewportInit, handleScrollbackPage, overlay.handleScrollbackPage, overlay.updateCacheFromSync])

    const pasteInput = useBracketedPaste(sendInput)

    const isMobile = useMemo(() => isMobileDevice(), [])

    const { setupScrolling, resetCopyMode } = useTerminalScrolling({
      wsRef,
      terminalRef,
      isMobile,
      sessionMode,
      onRequestScrollbackOverlay: overlay.activate,
      isScrollbackOverlayActive: overlay.isActive,
    })

    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally empty deps — reads refs at call time
    const handleTerminalData = useCallback(
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

    const { isReady } = useTerminalInstance(
      {
        cursorBlink,
        cursorStyle,
        fontSize,
        fontFamily,
        scrollback: effectiveScrollback,
        theme,
        onData: handleTerminalData,
        onPaste: pasteInput,
        setupScrolling,
      },
      { terminalRef, fitAddonRef, containerRef, isFocusedRef },
    )

    const { handleResize } = useTerminalResize({
      terminalRef,
      fitAddonRef,
      containerRef,
      wsRef,
      sendBackendResize: !suppressSharedResize,
    })

    useTerminalHandle(ref, {
      reconnect,
      sendInput,
      status,
      terminalRef,
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
          searchMatch={overlaySearchMatch}
          onDismiss={overlay.deactivate}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
        <TerminalDiagnosticsOverlay
          enabled={diagnosticsEnabled}
          themeId={inferredThemeId}
          sessionMode={sessionMode}
          getDiagnostics={getDiagnostics}
        />
      </div>
    )
  },
)
