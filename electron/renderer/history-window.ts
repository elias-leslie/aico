// Pure bookkeeping for the scrollback overlay's bounded window over tmux
// history. Lines are addressed absolutely: line 0 is the oldest history line
// tmux holds, and line `historySize + r` is the pane's visible row r. The
// overlay keeps at most `cap` of them in its xterm at once, so deep history
// costs a bounded amount of renderer memory however far back it reaches.

export interface HistoryPoint {
  /** Absolute tmux line. */
  line: number
  /** Cell column within the line. */
  col: number
}

/** Order two points so the first is the earlier one. */
export function orderPoints(a: HistoryPoint, b: HistoryPoint): [HistoryPoint, HistoryPoint] {
  if (a.line < b.line || (a.line === b.line && a.col <= b.col)) return [a, b]
  return [b, a]
}

/** Prepend an older page and drop the newest lines beyond the cap. */
export function prependWindow(
  current: string[],
  older: string[],
  cap: number,
): { lines: string[]; droppedNewest: number } {
  const merged = [...older, ...current]
  const droppedNewest = Math.max(0, merged.length - cap)
  return { lines: droppedNewest ? merged.slice(0, cap) : merged, droppedNewest }
}

/** Append a newer page and drop the oldest lines beyond the cap. */
export function appendWindow(
  current: string[],
  newer: string[],
  cap: number,
): { lines: string[]; droppedOldest: number } {
  const merged = [...current, ...newer]
  const droppedOldest = Math.max(0, merged.length - cap)
  return { lines: droppedOldest ? merged.slice(droppedOldest) : merged, droppedOldest }
}

/** First line of a page that puts `target` near the middle of the view. */
export function pageStartFor(
  target: number,
  totalLines: number,
  pageLines: number,
  rows: number,
): number {
  const centred = Math.floor(target - pageLines / 2 + rows / 2)
  return Math.max(0, Math.min(centred, Math.max(0, totalLines - pageLines)))
}

/** Map a 0..1 rail position to the absolute top line it represents. */
export function lineForFraction(fraction: number, totalLines: number, rows: number): number {
  const clamped = Math.min(1, Math.max(0, fraction))
  return Math.round(clamped * Math.max(0, totalLines - rows))
}

/** Thumb geometry for a viewport of `rows` lines starting at `topLine`. */
export function railThumb(
  topLine: number,
  rows: number,
  totalLines: number,
  trackPx: number,
  minThumbPx = 18,
): { offsetPx: number; sizePx: number } | null {
  if (totalLines <= rows || trackPx <= 0) return null
  const sizePx = Math.min(trackPx, Math.max(minThumbPx, (rows / totalLines) * trackPx))
  const scrollable = Math.max(1, totalLines - rows)
  const ratio = Math.min(1, Math.max(0, topLine / scrollable))
  return { offsetPx: ratio * (trackPx - sizePx), sizePx }
}

/** Word boundaries around `col` in a line of text (for double-click). */
export function wordBounds(text: string, col: number): [number, number] {
  const isWord = (ch: string | undefined) => ch !== undefined && /[^\s"'`()[\]{}<>|,;]/.test(ch)
  if (!isWord(text[col])) return [col, col]
  let start = col
  let end = col
  while (start > 0 && isWord(text[start - 1])) start -= 1
  while (end + 1 < text.length && isWord(text[end + 1])) end += 1
  return [start, end]
}

/**
 * Join the selected span of plain lines. `lines[0]` is `from.line`; the end
 * column is inclusive. Trailing blanks per line are trimmed like a terminal
 * copy.
 */
export function selectedText(lines: string[], from: HistoryPoint, to: HistoryPoint): string {
  const out: string[] = []
  const span = to.line - from.line
  for (let i = 0; i <= span && i < lines.length; i += 1) {
    const text = lines[i] ?? ''
    const start = i === 0 ? from.col : 0
    const end = i === span ? to.col + 1 : text.length
    out.push(text.slice(start, end).trimEnd())
  }
  return out.join('\n')
}
