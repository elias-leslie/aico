import type { IBufferLine, ILink, Terminal } from '@xterm/xterm'
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
 * Makes file paths in the terminal clickable: a click opens the path in the
 * Files viewer. Rows wrapped from one long line are read as one line.
 */
export function registerPathLinks(term: Terminal): { dispose(): void } {
  return term.registerLinkProvider({
    provideLinks(row, callback) {
      const buffer = term.buffer.active
      let first = row - 1
      while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1
      const lines: IBufferLine[] = []
      for (let y = first; ; y += 1) {
        const line = buffer.getLine(y)
        if (!line || (y > first && !line.isWrapped)) break
        lines.push(line)
      }
      const cols = term.cols
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
