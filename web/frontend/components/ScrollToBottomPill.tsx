'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  A_TERM_FONT_FAMILY,
  BOTTOM_OVERLAY_HEIGHT_VAR,
  PHOSPHOR_THEME,
} from '../lib/constants/a-term'

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
  const theme = PHOSPHOR_THEME
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
      className="pointer-events-none absolute inset-x-0 z-[5] flex justify-center"
      // Lift above anything overlaying the pane bottom (the compose box).
      style={{
        bottom: `calc(0.75rem + var(${BOTTOM_OVERLAY_HEIGHT_VAR}, 0px))`,
      }}
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
        className="pointer-events-auto inline-flex min-h-9 items-center gap-1.5 rounded-full px-4 text-xs shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-5 [@media(pointer:coarse)]:text-sm"
        style={{
          fontFamily: A_TERM_FONT_FAMILY,
          color: theme.green,
          background: `color-mix(in srgb, ${theme.background} 88%, ${theme.green})`,
          border: `1px solid ${theme.green}66`,
          outlineColor: theme.green,
        }}
      >
        <span aria-hidden="true">↓</span>
        <span>{state.newOutput ? 'New output' : 'Latest'}</span>
      </button>
    </div>
  )
}
