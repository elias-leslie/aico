import type { IBuffer, IBufferLine, ILink, Terminal } from '@xterm/xterm'
import { MAX_LINK_SCAN_CHARS } from '@/lib/constants/terminal'
import { openFiles } from '@/lib/files-opener'

/** An absolute or home path, starting where a word starts (so not the `//` of a URL). */
const PATH = /(?<=^|[\s"'`(<[{=])~?\/[^\s"'`<>()[\]{}|]+/g
/** Trailing punctuation and a `:line:col` suffix are not part of the path. */
const TRAILING = /(?::\d+){1,2}$|[.,:;!?]+$/

export interface FoundPath {
  path: string
  /** Offsets into the text, end exclusive. */
  start: number
  end: number
}

/** The file paths in a line of terminal text. */
export function findPaths(text: string): FoundPath[] {
  const found: FoundPath[] = []
  for (const match of text.matchAll(PATH)) {
    let path = match[0]
    for (let next = path.replace(TRAILING, ''); next !== path; ) {
      path = next
      next = path.replace(TRAILING, '')
    }
    // A bare `/` or `~/` names nothing worth opening.
    if (path.replace(/^~/, '').length < 2) continue
    found.push({ path, start: match.index, end: match.index + path.length })
  }
  return found
}

/**
 * The wrapped rows that read as one line around `row` (0-based), at most
 * `maxChars` of text either side, and never past the rows the buffer holds.
 *
 * xterm's `getLine` answers past the last row too: its rows wrap around, so a
 * screen where every row is marked wrapped (a full-screen program painting
 * wider than the pane, as in the middle of a resize) never reached the end of
 * the chain, and this loop built rows until the page ran out of memory.
 */
export function wrappedRows(
  buffer: Pick<IBuffer, 'length' | 'getLine'>,
  row: number,
  cols: number,
  maxChars: number = MAX_LINK_SCAN_CHARS,
): { first: number; lines: IBufferLine[] } {
  if (row < 0 || row >= buffer.length) return { first: row, lines: [] }
  const span = Math.max(1, Math.ceil(maxChars / Math.max(cols, 1)))
  let first = row
  const floor = Math.max(0, first - span)
  while (first > floor && buffer.getLine(first)?.isWrapped) first -= 1
  const end = Math.min(buffer.length, row + 1 + span)
  const lines: IBufferLine[] = []
  for (let y = first; y < end; y += 1) {
    const line = buffer.getLine(y)
    if (!line || (y > first && !line.isWrapped)) break
    lines.push(line)
  }
  return { first, lines }
}

/**
 * Makes file paths in the terminal clickable: a click opens the path in the
 * Files viewer. Rows wrapped from one long line are read as one line.
 */
export function registerPathLinks(term: Terminal): { dispose(): void } {
  return term.registerLinkProvider({
    provideLinks(row, callback) {
      const cols = term.cols
      const { first, lines } = wrappedRows(term.buffer.active, row - 1, cols)
      const text = lines
        .map((line, index) =>
          line.translateToString(index === lines.length - 1),
        )
        .join('')
      const at = (offset: number) => ({
        x: (offset % cols) + 1,
        y: first + Math.floor(offset / cols) + 1,
      })
      const links: ILink[] = findPaths(text)
        .map(({ path, start, end }) => ({
          text: path,
          range: { start: at(start), end: at(end - 1) },
          activate: () => {
            openFiles({ kind: 'path', path })
          },
        }))
        .filter(({ range }) => range.start.y <= row && range.end.y >= row)
      callback(links.length ? links : undefined)
    },
  })
}
