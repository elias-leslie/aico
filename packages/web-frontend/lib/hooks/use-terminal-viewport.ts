'use client'

import { type RefObject, useEffect, useRef } from 'react'

export type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

/**
 * Calls `onChange` once the terminal is ready and again whenever its view moves (scroll, new output
 * parsed, resize). `onStop` runs when the listening ends.
 */
export function useTerminalViewport(
  terminalRef: RefObject<XtermTerminal | null>,
  isReady: boolean,
  onChange: (term: XtermTerminal) => void,
  onStop?: () => void,
) {
  const latest = useRef({ onChange, onStop })
  latest.current = { onChange, onStop }
  useEffect(() => {
    const term = terminalRef.current
    if (!isReady || !term) return
    const update = () => latest.current.onChange(term)
    update()
    const subscriptions = [
      term.onScroll(update),
      term.onWriteParsed(update),
      term.onResize(update),
    ]
    return () => {
      for (const subscription of subscriptions) subscription.dispose()
      latest.current.onStop?.()
    }
  }, [terminalRef, isReady])
}
