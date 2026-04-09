import { describe, expect, it, vi } from 'vitest'
import {
  applyATermSearchSelection,
  buildATermSearchResult,
  buildEmptyATermSearchResult,
  findATermSearchMatches,
  getATermSearchIndex,
} from './a-term-search'

describe('findATermSearchMatches', () => {
  it('finds all case-insensitive matches across lines', () => {
    expect(
      findATermSearchMatches(['Alpha beta alpha', 'gamma', 'ALPHA'], 'alpha'),
    ).toEqual([
      { line: 0, column: 0, length: 5 },
      { line: 0, column: 11, length: 5 },
      { line: 2, column: 0, length: 5 },
    ])
  })

  it('returns no matches for blank queries', () => {
    expect(findATermSearchMatches(['alpha'], '   ')).toEqual([])
  })

  it('computes columns from visible text when lines contain ANSI escapes', () => {
    expect(
      findATermSearchMatches(
        ['prefix \x1b[32mSummitFlow\x1b[0m suffix'],
        'SummitFlow',
      ),
    ).toEqual([{ line: 0, column: 7, length: 10 }])
  })
})

describe('getATermSearchIndex', () => {
  it('starts at the first result for next searches', () => {
    expect(getATermSearchIndex(3, -1, 'next', true)).toBe(0)
  })

  it('starts at the last result for previous searches', () => {
    expect(getATermSearchIndex(3, -1, 'previous', true)).toBe(2)
  })

  it('wraps around when moving past the last result', () => {
    expect(getATermSearchIndex(3, 2, 'next', false)).toBe(0)
  })
})

describe('a-term search result builders', () => {
  it('creates empty results', () => {
    expect(buildEmptyATermSearchResult('alpha')).toEqual({
      query: 'alpha',
      totalMatches: 0,
      activeIndex: -1,
      found: false,
    })
  })

  it('creates found results', () => {
    expect(buildATermSearchResult('alpha', 4, 1)).toEqual({
      query: 'alpha',
      totalMatches: 4,
      activeIndex: 1,
      found: true,
    })
  })
})

describe('applyATermSearchSelection', () => {
  it('selects the match and scrolls it into view', () => {
    const clearSelection = vi.fn()
    const select = vi.fn()
    const scrollToLine = vi.fn()
    const term = {
      rows: 20,
      clearSelection,
      select,
      scrollToLine,
    } as unknown as Parameters<typeof applyATermSearchSelection>[0]

    applyATermSearchSelection(term, {
      line: 30,
      column: 4,
      length: 6,
    })

    expect(clearSelection).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith(4, 30, 6)
    expect(scrollToLine).toHaveBeenCalledWith(20)
  })
})
