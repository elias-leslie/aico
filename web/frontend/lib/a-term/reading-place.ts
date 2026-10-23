// Keep a reader who scrolled up in the same place when the terminal changes
// its number of rows (window drag, phone keyboard or accessory bar, fit).
// xterm moves the viewport by the number of rows added or removed whenever
// the cursor sits at the bottom, even for a reader above it, so the text under
// their eyes slides. Only the row count is handled: a width change reflows
// the lines, which xterm accounts for itself.

import type { IDisposable, Terminal } from '@xterm/xterm'

export function keepReadingPlace(term: Terminal): IDisposable {
  let place: number | null = null
  let cols = term.cols

  const sample = () => {
    const buffer = term.buffer.active
    place = buffer.viewportY < buffer.baseY ? buffer.viewportY : null
  }
  sample()

  const disposables = [
    term.onWriteParsed(sample),
    term.onScroll(sample),
    term.onResize(() => {
      if (place !== null && term.cols === cols) term.scrollToLine(place)
      cols = term.cols
      sample()
    }),
  ]
  return {
    dispose: () => {
      for (const d of disposables) d.dispose()
    },
  }
}
