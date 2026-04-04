import type { TerminalSearchDirection, TerminalSearchResult } from '@/components/terminal.types'

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

// Strips the ANSI sequences we keep in tmux-backed scrollback snapshots so
// search coordinates line up with the visible xterm cells.
const ANSI_SEARCH_ESCAPE_REGEX =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g

export interface TerminalSearchMatch {
  line: number
  column: number
  length: number
}

export function buildEmptyTerminalSearchResult(query = ''): TerminalSearchResult {
  return {
    query,
    totalMatches: 0,
    activeIndex: -1,
    found: false,
  }
}

export function findTerminalSearchMatches(
  lines: string[],
  query: string,
): TerminalSearchMatch[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const needle = trimmed.toLocaleLowerCase()
  const matches: TerminalSearchMatch[] = []

  for (const [lineIndex, line] of lines.entries()) {
    const haystack = line
      .replaceAll(ANSI_SEARCH_ESCAPE_REGEX, '')
      .toLocaleLowerCase()
    let offset = 0

    while (offset <= haystack.length - needle.length) {
      const column = haystack.indexOf(needle, offset)
      if (column === -1) break
      matches.push({ line: lineIndex, column, length: trimmed.length })
      offset = column + Math.max(needle.length, 1)
    }
  }

  return matches
}

export function getTerminalSearchIndex(
  totalMatches: number,
  currentIndex: number,
  direction: TerminalSearchDirection,
  reset: boolean,
): number {
  if (totalMatches <= 0) return -1
  if (reset || currentIndex < 0 || currentIndex >= totalMatches) {
    return direction === 'previous' ? totalMatches - 1 : 0
  }
  return direction === 'previous'
    ? (currentIndex - 1 + totalMatches) % totalMatches
    : (currentIndex + 1) % totalMatches
}

export function buildTerminalSearchResult(
  query: string,
  totalMatches: number,
  activeIndex: number,
): TerminalSearchResult {
  if (totalMatches <= 0 || activeIndex < 0) {
    return buildEmptyTerminalSearchResult(query)
  }
  return {
    query,
    totalMatches,
    activeIndex,
    found: true,
  }
}

export function applyTerminalSearchSelection(
  term: XtermTerminal,
  match: TerminalSearchMatch,
): void {
  term.clearSelection()
  term.select(match.column, match.line, match.length)
  const targetLine = Math.max(match.line - Math.floor(term.rows / 2), 0)
  term.scrollToLine(targetLine)
}
