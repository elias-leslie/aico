'use client'

import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

interface ScrollToBottomPillProps {
  aTermRef: React.RefObject<XtermATerm | null>
  /** The terminal exists and can be listened to. */
  isReady: boolean
}

interface ReadingState {
  scrolledUp: boolean
  newOutput: boolean
}

interface Tracker {
  viewportY: number
  distance: number
}

const AT_BOTTOM: ReadingState = { scrolledUp: false, newOutput: false }

/**
 * Where the reader is relative to the live bottom. `tracker` remembers the
 * view when they last moved it; output that arrives while they stay put
 * pushes the bottom further away, which is what "new output" means.
 */
export function readViewport(
  term: Pick<XtermATerm, 'buffer'>,
  tracker: { current: Tracker | null },
): ReadingState {
  const { baseY, viewportY } = term.buffer.active
  const distance = baseY - viewportY
  if (distance <= 0) {
    tracker.current = null
    return AT_BOTTOM
  }
  const last = tracker.current
  if (!last || last.viewportY !== viewportY) {
    tracker.current = { viewportY, distance }
    return { scrolledUp: true, newOutput: false }
  }
  return { scrolledUp: true, newOutput: distance > last.distance }
}

/**
 * Shown only while the reader is above the live bottom. Tapping it scrolls to
 * the bottom; the write queue sees that move and asks for the repaint it held
 * back while they were reading. It never takes focus, so the phone keyboard
 * and the compose box stay as they were.
 */
export function ScrollToBottomPill({
  aTermRef,
  isReady,
}: ScrollToBottomPillProps) {
  const [state, setState] = useState<ReadingState>(AT_BOTTOM)
  const trackerRef = useRef<Tracker | null>(null)

  useEffect(() => {
    const term = aTermRef.current
    if (!isReady || !term) return
    const update = () => {
      const next = readViewport(term, trackerRef)
      setState((prev) =>
        prev.scrolledUp === next.scrolledUp && prev.newOutput === next.newOutput
          ? prev
          : next,
      )
    }
    update()
    const subscriptions = [
      term.onScroll(update),
      term.onWriteParsed(update),
      term.onResize(update),
    ]
    return () => {
      for (const subscription of subscriptions) subscription.dispose()
      trackerRef.current = null
    }
  }, [aTermRef, isReady])

  const jump = useCallback(() => {
    aTermRef.current?.scrollToBottom()
  }, [aTermRef])

  if (!state.scrolledUp) return null

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-3 z-[5] flex justify-center"
      data-testid="a-term-scroll-to-bottom"
    >
      <button
        type="button"
        onClick={jump}
        // Keep the terminal's focus: a tap here must not move the caret or
        // bring up the phone keyboard.
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.pointerType !== 'mouse') event.preventDefault()
        }}
        aria-label={
          state.newOutput
            ? 'Jump to latest output, new output below'
            : 'Jump to latest output'
        }
        className="lantern-jump pointer-events-auto"
      >
        <ArrowDown
          aria-hidden="true"
          className="h-3.5 w-3.5"
          strokeWidth={1.7}
        />
        <span>{state.newOutput ? 'New output' : 'Latest'}</span>
      </button>
    </div>
  )
}
