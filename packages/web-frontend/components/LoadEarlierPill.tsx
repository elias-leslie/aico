'use client'

import { ArrowUp } from 'lucide-react'
import { useState } from 'react'
import {
  useTerminalViewport,
  type XtermTerminal,
} from '../lib/hooks/use-terminal-viewport'
import type { HistoryFrame } from '../lib/hooks/use-websocket-connection'

interface LoadEarlierPillProps {
  terminalRef: React.RefObject<XtermTerminal | null>
  /** The terminal exists and can be listened to. */
  isReady: boolean
  /** What the last seed carried; null until the server said. */
  history: HistoryFrame | null
  /** Lines one tap adds. */
  step: number
  /** Earlier lines were asked for and have not arrived yet. */
  loading: boolean
  onLoad: () => void
}

const count = (n: number) => n.toLocaleString('en-US')

/** The reader is at the top of the history this view holds. */
function atTop(term: XtermTerminal): boolean {
  const buffer = term.buffer.active
  return buffer.type === 'normal' && buffer.baseY > 0 && buffer.viewportY === 0
}

/**
 * Shown at the top of the history when the session holds earlier lines than
 * this view loaded (a phone loads the last few thousand). Tapping it loads
 * more and keeps the reader on the line they were reading. Like the jump
 * pill, it never takes focus.
 */
export function LoadEarlierPill({
  terminalRef,
  isReady,
  history,
  step,
  loading,
  onLoad,
}: LoadEarlierPillProps) {
  const [top, setTop] = useState(false)

  useTerminalViewport(terminalRef, isReady, (term) => setTop(atTop(term)))

  const more = history ? history.total - history.lines : 0
  if (!history || (!loading && (more <= 0 || !top))) return null

  // The count is on the button itself, not only in the tooltip, so it is
  // read out and found by anything that reads the page as text.
  const shown = `${count(history.lines)} of ${count(history.total)} shown`
  const detail = loading
    ? 'Loading earlier lines'
    : `Showing the last ${count(history.lines)} of ${count(history.total)} lines. Load ${count(Math.min(step, more))} earlier lines.`

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-3 z-[5] flex justify-center"
      data-testid="terminal-load-earlier"
    >
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        aria-busy={loading}
        // Keep the terminal's focus: a tap here must not bring up the keyboard.
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.pointerType !== 'mouse') event.preventDefault()
        }}
        title={detail}
        className="lantern-jump pointer-events-auto disabled:opacity-70"
      >
        <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.7} />
        <span>{loading ? 'Loading earlier lines…' : 'Load earlier'}</span>
        {!loading && <span className="font-normal opacity-80">{shown}</span>}
      </button>
    </div>
  )
}
