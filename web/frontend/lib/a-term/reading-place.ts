// Keep a reader who scrolled up in the same place when the terminal changes
// its number of rows (window drag, phone keyboard or accessory bar, fit).
// xterm moves the viewport by the number of rows added or removed whenever
// the cursor sits at the bottom, even for a reader above it, and a full
// scrollback drops lines off the top at the same time, so the text under
// their eyes slides. A marker on the top visible line follows that line through
// both; after a row-only resize the viewport goes back to it. A width change
// reflows the lines, which xterm accounts for itself.

import type { IDisposable, IMarker, Terminal } from '@xterm/xterm'

export function keepReadingPlace(term: Terminal): IDisposable {
  let topLine: IMarker | undefined
  let cols = term.cols

  const sample = () => {
    topLine?.dispose()
    topLine = undefined
    const buffer = term.buffer.active
    if (buffer.viewportY >= buffer.baseY) return
    topLine = term.registerMarker(
      buffer.viewportY - (buffer.baseY + buffer.cursorY),
    )
  }
  sample()

  const disposables = [
    term.onWriteParsed(sample),
    term.onScroll(sample),
    term.onResize(() => {
      if (topLine && topLine.line >= 0 && term.cols === cols) {
        term.scrollToLine(topLine.line)
      }
      cols = term.cols
      sample()
    }),
  ]
  return {
    dispose: () => {
      for (const d of disposables) d.dispose()
      topLine?.dispose()
    },
  }
}
