import { describe, expect, it, vi } from 'vitest'
import {
  applyTerminalSearchSelection,
  buildEmptyTerminalSearchResult,
  buildTerminalSearchResult,
  findTerminalSearchMatches,
  getTerminalSearchIndex,
} from './terminal-search'

describe('findTerminalSearchMatches', () => {
  it('finds all case-insensitive matches across lines', () => {
    expect(
      findTerminalSearchMatches(
        ['Alpha beta alpha', 'gamma', 'ALPHA'],
        'alpha',
      ),
    ).toEqual([
      { line: 0, column: 0, length: 5 },
      { line: 0, column: 11, length: 5 },
      { line: 2, column: 0, length: 5 },
    ])
  })

  it('returns no matches for blank queries', () => {
    expect(findTerminalSearchMatches(['alpha'], '   ')).toEqual([])
  })

  it('computes columns from visible text when lines contain ANSI escapes', () => {
    expect(
      findTerminalSearchMatches(
        ['prefix \x1b[32mSummitFlow\x1b[0m suffix'],
        'SummitFlow',
      ),
    ).toEqual([
      { line: 0, column: 7, length: 10 },
    ])
  })
})

describe('getTerminalSearchIndex', () => {
  it('starts at the first result for next searches', () => {
    expect(getTerminalSearchIndex(3, -1, 'next', true)).toBe(0)
  })

  it('starts at the last result for previous searches', () => {
    expect(getTerminalSearchIndex(3, -1, 'previous', true)).toBe(2)
  })

  it('wraps around when moving past the last result', () => {
    expect(getTerminalSearchIndex(3, 2, 'next', false)).toBe(0)
  })
})

describe('terminal search result builders', () => {
  it('creates empty results', () => {
    expect(buildEmptyTerminalSearchResult('alpha')).toEqual({
      query: 'alpha',
      totalMatches: 0,
      activeIndex: -1,
      found: false,
    })
  })

  it('creates found results', () => {
    expect(buildTerminalSearchResult('alpha', 4, 1)).toEqual({
      query: 'alpha',
      totalMatches: 4,
      activeIndex: 1,
      found: true,
    })
  })
})

describe('applyTerminalSearchSelection', () => {
  it('selects the match and scrolls it into view', () => {
    const clearSelection = vi.fn()
    const select = vi.fn()
    const scrollToLine = vi.fn()
    const term = {
      rows: 20,
      clearSelection,
      select,
      scrollToLine,
    } as unknown as Parameters<typeof applyTerminalSearchSelection>[0]

    applyTerminalSearchSelection(term, {
      line: 30,
      column: 4,
      length: 6,
    })

    expect(clearSelection).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith(4, 30, 6)
    expect(scrollToLine).toHaveBeenCalledWith(20)
  })
})
