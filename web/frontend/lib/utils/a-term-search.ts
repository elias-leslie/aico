import type {
  ATermSearchDirection,
  ATermSearchResult,
} from '@/components/a-term.types'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

// Strips the ANSI sequences we keep in tmux-backed scrollback snapshots so
// search coordinates line up with the visible xterm cells.
const ANSI_SEARCH_ESCAPE_REGEX =
  // biome-ignore lint/complexity/useRegexLiterals: String escapes avoid control-character false positives for ANSI matching.
  new RegExp(
    String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))`,
    'g',
  )

export interface ATermSearchMatch {
  line: number
  column: number
  length: number
}

export function buildEmptyATermSearchResult(query = ''): ATermSearchResult {
  return {
    query,
    totalMatches: 0,
    activeIndex: -1,
    found: false,
  }
}

export function findATermSearchMatches(
  lines: string[],
  query: string,
): ATermSearchMatch[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const needle = trimmed.toLocaleLowerCase()
  const matches: ATermSearchMatch[] = []

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

export function getATermSearchIndex(
  totalMatches: number,
  currentIndex: number,
  direction: ATermSearchDirection,
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

export function buildATermSearchResult(
  query: string,
  totalMatches: number,
  activeIndex: number,
): ATermSearchResult {
  if (totalMatches <= 0 || activeIndex < 0) {
    return buildEmptyATermSearchResult(query)
  }
  return {
    query,
    totalMatches,
    activeIndex,
    found: true,
  }
}

export function applyATermSearchSelection(
  term: XtermATerm,
  match: ATermSearchMatch,
): void {
  term.clearSelection()
  term.select(match.column, match.line, match.length)
  const targetLine = Math.max(match.line - Math.floor(term.rows / 2), 0)
  term.scrollToLine(targetLine)
}
