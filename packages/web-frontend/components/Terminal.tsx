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
import { sizeHolderName } from '@aico/ui-kit/size-holder-copy'
import {
  LANTERN_TERMINAL_THEME,
  LOAD_EARLIER_LINES,
  PHONE_HISTORY_LINES,
  SCROLLBACK,
} from '../lib/constants/terminal'
import { wasCreatedHere } from '../lib/created-here'
import type { TerminalRendererStatus } from '../lib/hooks/terminal-instance-utils'
import { useTerminalHandle } from '../lib/hooks/use-terminal-handle'
import { useTerminalInstance } from '../lib/hooks/use-terminal-instance'
import { useTerminalResize } from '../lib/hooks/use-terminal-resize'
import { useTerminalScrolling } from '../lib/hooks/use-terminal-scrolling'
import { useTerminalSearch } from '../lib/hooks/use-terminal-search'
import { useTerminalWebSocket } from '../lib/hooks/use-terminal-websocket'
import { useTerminalWriteQueue } from '../lib/hooks/use-terminal-write-queue'
import {
  type HistoryFrame,
  MSG_CONTROL,
} from '../lib/hooks/use-websocket-connection'
import {
  swallowQueryReplies,
  trackSgrMouse,
} from '../lib/terminal/control-view'
import { usableDimensions } from '../lib/terminal/fit'
import { keepReadingPlace } from '../lib/terminal/reading-place'
import { isMobileDevice } from '../lib/utils/device'
import { type ViewSize, viewRefresh } from '../lib/utils/view-refresh'
import { LoadEarlierPill } from './LoadEarlierPill'
import { ScrollToBottomPill } from './ScrollToBottomPill'
import type { TerminalHandle, TerminalProps } from './terminal.types'

export type {
  ConnectionStatus,
  TerminalHandle,
  TerminalProps,
} from './terminal.types'

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>
type XtermFitAddon = InstanceType<typeof import('@xterm/addon-fit').FitAddon>

/** Another device must hold the size this long before the notice shows, so a
 * claim taken back at once never flashes it (as the desktop's size-holder.ts). */
const SIZE_NOTICE_DELAY_MS = 600
/** Typing takes the size back at most this often. */
const RECLAIM_SPACING_MS = 1500
const INPUT_ANSWER_MS = 4000

function isObserverModeEnabled(search: string): boolean {
  const value = new URLSearchParams(search).get('observer')
  return value === '1' || value === 'true'
}

/** The owner is looking at this page now (the focused, visible window). */
function isPageActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function pongOf(data: unknown): { live?: boolean } | null {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : null
  if (view?.[0] !== MSG_CONTROL) return null
  try {
    const frame = JSON.parse(new TextDecoder().decode(view.subarray(1)))
    return frame?.pong === true ? frame : null
  } catch {
    return null
  }
}

/** A socket can look open after the phone lost its network. Messages arrive in
 * order, so the server's answer to a probe means it has all that was sent before,
 * and it says whether that went on to the session (`live`). */
export function serverAnswers(
  ws: WebSocket,
  reconnect: () => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      const pong = pongOf(event.data)
      if (!pong) return
      clearTimeout(timer)
      ws.removeEventListener('message', listener)
      resolve(pong.live !== false)
    }
    const timer = setTimeout(() => {
      ws.removeEventListener('message', listener)
      if (ws.readyState === WebSocket.OPEN) reconnect()
      resolve(false)
    }, INPUT_ANSWER_MS)
    ws.addEventListener('message', listener)
    ws.send(JSON.stringify({ __ctrl: true, ping: true, probe: true }))
  })
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
      fontSize = 14,
      isVisible = true,
      onFilePaste,
      onSizeHolderChange,
      onHostStateChange,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<XtermTerminal | null>(null)
    const fitAddonRef = useRef<XtermFitAddon | null>(null)
    const isFocusedRef = useRef(false)
    const isVisibleRef = useRef(isVisible)
    const rendererStatusRef = useRef<TerminalRendererStatus | null>(null)
    // An observer (`?observer=1`) never sizes the session, even when typing.
    const isObserver = useMemo(
      () =>
        typeof window !== 'undefined' &&
        isObserverModeEnabled(window.location.search),
      [],
    )

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

    const { enqueueWrite, restartStream, onViewportMoved, expectReset } =
      useTerminalWriteQueue({
        terminalRef,
        isVisibleRef,
        reseed: reseedSource,
      })

    // Looking does not take the shared size; using the view does. Another
    // device holds it: its name (null while this view holds it, or nobody has
    // said), and the session's size, which this view then shows.
    const [heldBy, setHeldBy] = useState<string | null>(null)
    const [holdsSize, setHoldsSize] = useState(false)
    const holdsSizeRef = useRef(false)
    const [viewSize, setViewSize] = useState<{
      cols: number
      rows: number
    } | null>(null)
    const lastReclaimRef = useRef(0)
    const reclaimRef = useRef<() => void>(() => {})
    // The owner's own other tab or window holds the size: the one they are
    // looking at takes it back, on connecting and when it gains focus.
    const sameBrowserHolderRef = useRef(false)
    const heardHolderRef = useRef(false)
    // A remote session's host is away: the terminal shows no output and
    // takes no input until it is live again.
    const hostAwayRef = useRef(false)
    const onHostStateChangeRef = useRef(onHostStateChange)
    onHostStateChangeRef.current = onHostStateChange

    // History lines this view's seeds carry: a phone loads the last few
    // thousand (a slow link pays for each line on every attach) and more on
    // Load earlier; null loads all the server carries.
    const historyBudgetRef = useRef<number | null>(
      typeof window !== 'undefined' && isMobileDevice()
        ? PHONE_HISTORY_LINES
        : null,
    )
    const [history, setHistory] = useState<HistoryFrame | null>(null)
    // The view's size when the last seed came, and the size it last showed
    // the session at (null: its own fitted size).
    const seedSizeRef = useRef<ViewSize | null>(null)
    const shownSizeRef = useRef<ViewSize | null>(null)
    const [loadingEarlier, setLoadingEarlier] = useState(false)

    const { status, wsRef, reconnect, sendInput, connect, disconnect } =
      useTerminalWebSocket({
        sessionId,
        workingDir,
        sendInitialResize: !isObserver,
        onHistoryLines: (historyLines) => {
          // Size the buffer now, before the seed is written, not on the
          // next render.
          if (terminalRef.current)
            terminalRef.current.options.scrollback = historyLines
          setControlHistoryLines(historyLines)
        },
        getHistoryLines: () => historyBudgetRef.current,
        onHistory: (frame) => {
          // A seed just came (the notice follows its data): it is laid out
          // at this view's size now.
          const term = terminalRef.current
          if (term) seedSizeRef.current = { cols: term.cols, rows: term.rows }
          setHistory(frame)
          setLoadingEarlier(false)
        },
        onStatusChange,
        onDisconnect,
        onBeforeReconnectData: restartStream,
        onMessage: (data) => {
          if (!terminalRef.current) return
          enqueueWrite(data)
        },
        onSizeHolder: ({ here, viewer, size, sameBrowser }) => {
          const first = !heardHolderRef.current
          heardHolderRef.current = true
          holdsSizeRef.current = here
          sameBrowserHolderRef.current = !here && sameBrowser
          if (
            first &&
            sameBrowserHolderRef.current &&
            !isObserver &&
            isPageActive()
          ) {
            reclaimRef.current()
            return
          }
          // Nobody named holds it and this browser just started the session: it takes the size.
          if (
            first &&
            !here &&
            !viewer &&
            !isObserver &&
            wasCreatedHere(sessionId) &&
            isPageActive()
          ) {
            reclaimRef.current()
            return
          }
          setHoldsSize(here)
          setHeldBy(here ? null : sizeHolderName(viewer))
          setViewSize(here ? null : size)
        },
        onHostState: (frame) => {
          hostAwayRef.current = frame.state !== 'live'
          onHostStateChangeRef.current?.(hostAwayRef.current ? frame : null)
        },
        // The size this view would take, sent unclaimed at connect: the
        // server claims with it only when nobody holds the size yet.
        getDimensions: () =>
          !isObserver && isVisibleRef.current && fitAddonRef.current
            ? usableDimensions(fitAddonRef.current)
            : null,
      })

    useEffect(() => {
      reseedWsRef.current = wsRef
    }, [wsRef])

    const sendRendererStatus = useCallback(
      (rendererStatus: TerminalRendererStatus) => {
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

    const { clearSearch, search } = useTerminalSearch({ terminalRef })

    // Input from this view (keys, paste, toolbar, compose, an uploaded file's
    // path) takes the size when another view holds it, at most this often.
    const claimOnInput = useCallback(() => {
      if (isObserver || holdsSizeRef.current) return
      const now = Date.now()
      if (now - lastReclaimRef.current < RECLAIM_SPACING_MS) return
      lastReclaimRef.current = now
      reclaimRef.current()
    }, [isObserver])
    const sendUsedInput = useCallback(
      (data: string) => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) return
        sendInput(data)
        claimOnInput()
      },
      [claimOnInput, sendInput, wsRef],
    )

    // Paste goes through tmux, which brackets the text only when the program
    // enabled bracketed paste.
    const pasteInput = useCallback(
      (data: string) => {
        const text = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        if (text && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ __ctrl: true, paste: text }))
          claimOnInput()
        }
        return Promise.resolve()
      },
      [claimOnInput, wsRef],
    )
    const inputArrived = useCallback(() => {
      const ws = wsRef.current
      return ws?.readyState === WebSocket.OPEN
        ? serverAnswers(ws, reconnect)
        : Promise.resolve(false)
    }, [reconnect, wsRef])
    const pasteFile = useCallback(
      (file: File) => {
        void onFilePaste?.(file, sessionId)
      },
      [onFilePaste, sessionId],
    )

    const isMobile = useMemo(() => isMobileDevice(), [])

    const { setupScrolling } = useTerminalScrolling({
      wsRef,
      terminalRef,
      isMobile,
      isSgrMouse,
    })

    const handleTerminalData = useCallback(
      (data: string) => {
        if (!isFocusedRef.current || hostAwayRef.current) return
        sendUsedInput(data)
      },
      [sendUsedInput],
    )

    const { isReady } = useTerminalInstance(
      {
        sessionMode,
        fontSize,
        scrollback: controlHistoryLines ?? SCROLLBACK,
        onData: handleTerminalData,
        onPaste: pasteInput,
        onFilePaste: pasteFile,
        onRendererStatus: sendRendererStatus,
        setupScrolling,
      },
      { terminalRef, fitAddonRef, containerRef, isFocusedRef },
    )

    useEffect(() => {
      const term = terminalRef.current
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

    const { handleResize } = useTerminalResize({
      terminalRef,
      fitAddonRef,
      containerRef,
      wsRef,
      canClaim: !isObserver && isVisible,
      holdsSize,
      viewSize,
    })

    // Claiming fits this view at once; the holder notice confirms it.
    const claimSize = useCallback(() => {
      setViewSize(null)
      handleResize()
    }, [handleResize])
    reclaimRef.current = claimSize

    // Shown at another size than before: the visible screen is read again at
    // it (xterm reflowed the history itself), or the whole pane when the last
    // seed was laid out at this view's own size (see viewRefresh).
    const viewCols = viewSize?.cols ?? 0
    const viewRows = viewSize?.rows ?? 0
    // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the shown size changes
    useEffect(() => {
      const previous = shownSizeRef.current
      const next = viewCols > 0 ? { cols: viewCols, rows: viewRows } : null
      shownSizeRef.current = next
      if (!next || wsRef.current?.readyState !== WebSocket.OPEN) return
      const refresh =
        viewRefresh(previous, next, seedSizeRef.current) === 'seed'
          ? true
          : 'screen'
      wsRef.current.send(JSON.stringify({ __ctrl: true, refresh }))
    }, [viewCols, viewRows])

    // Load earlier: the server sends the pane again with more history; the
    // reader stays on the line they were reading, now further down.
    const loadEarlier = useCallback(() => {
      const ws = wsRef.current
      const term = terminalRef.current
      if (!history || !term || ws?.readyState !== WebSocket.OPEN) return
      const lines = Math.min(history.total, history.lines + LOAD_EARLIER_LINES)
      historyBudgetRef.current = lines
      const before = term.buffer.normal.length
      const viewportY = term.buffer.active.viewportY
      expectReset(() => {
        const added = term.buffer.normal.length - before
        term.scrollToLine(Math.max(0, viewportY + added))
      })
      setLoadingEarlier(true)
      ws.send(
        JSON.stringify({ __ctrl: true, refresh: true, history_lines: lines }),
      )
    }, [expectReset, history, wsRef])

    const reconnectHost = useCallback(() => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      wsRef.current.send(JSON.stringify({ __ctrl: true, reconnect: true }))
    }, [wsRef])

    useTerminalHandle(ref, {
      reconnect,
      sendInput: sendUsedInput,
      inputArrived,
      claimSize,
      reconnectHost,
      status,
      terminalRef,
      search,
      clearSearch,
    })

    // Back to this window while the owner's other tab holds the size.
    useEffect(() => {
      if (isObserver) return
      const takeBack = () => {
        if (sameBrowserHolderRef.current && isPageActive()) reclaimRef.current()
      }
      window.addEventListener('focus', takeBack)
      document.addEventListener('visibilitychange', takeBack)
      return () => {
        window.removeEventListener('focus', takeBack)
        document.removeEventListener('visibilitychange', takeBack)
      }
    }, [isObserver])

    // A new connection hears the holder afresh.
    useEffect(() => {
      if (status === 'connected') return
      setLoadingEarlier(false)
      heardHolderRef.current = false
      sameBrowserHolderRef.current = false
      holdsSizeRef.current = false
      setHoldsSize(false)
      setHeldBy(null)
      if (hostAwayRef.current) {
        hostAwayRef.current = false
        onHostStateChangeRef.current?.(null)
      }
    }, [status])

    useEffect(() => {
      if (heldBy === null) {
        onSizeHolderChange?.(null)
        return
      }
      const timer = setTimeout(
        () => onSizeHolderChange?.(heldBy),
        SIZE_NOTICE_DELAY_MS,
      )
      return () => clearTimeout(timer)
    }, [heldBy, onSizeHolderChange])

    useEffect(() => {
      if (isVisible && isReady) {
        connect()
        return
      }
      disconnect()
    }, [connect, disconnect, isReady, isVisible])

    return (
      <div
        className={clsx(
          'relative h-full w-full min-h-0 min-w-0 overflow-hidden',
          className,
        )}
      >
        <div
          ref={containerRef}
          data-testid="terminal-live-container"
          data-view-size={
            viewSize ? `${viewSize.cols}x${viewSize.rows}` : undefined
          }
          className={clsx(
            'h-full min-h-0 min-w-0',
            viewSize ? 'overflow-auto' : 'overflow-hidden',
          )}
          style={{
            backgroundColor: LANTERN_TERMINAL_THEME.background,
            width: '100%',
          }}
        />
        {status === 'connected' && (
          <LoadEarlierPill
            terminalRef={terminalRef}
            isReady={isReady}
            history={history}
            step={LOAD_EARLIER_LINES}
            loading={loadingEarlier}
            onLoad={loadEarlier}
          />
        )}
        <ScrollToBottomPill terminalRef={terminalRef} isReady={isReady} />
      </div>
    )
  },
)
