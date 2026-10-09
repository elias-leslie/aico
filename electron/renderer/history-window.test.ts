import { describe, expect, it } from 'vitest'
import {
  appendWindow,
  lineForFraction,
  orderPoints,
  pageStartFor,
  prependWindow,
  railThumb,
  selectedText,
  wordBounds,
} from './history-window'

describe('history window paging', () => {
  it('keeps the window bounded by dropping the far end', () => {
    expect(prependWindow(['c', 'd'], ['a', 'b'], 3)).toEqual({
      lines: ['a', 'b', 'c'],
      droppedNewest: 1,
    })
    expect(appendWindow(['a', 'b'], ['c', 'd'], 3)).toEqual({
      lines: ['b', 'c', 'd'],
      droppedOldest: 1,
    })
    expect(appendWindow(['a'], ['b'], 3)).toEqual({ lines: ['a', 'b'], droppedOldest: 0 })
  })

  it('centres a seek page on the target and clamps it to the history', () => {
    expect(pageStartFor(50_000, 200_000, 5000, 40)).toBe(47_520)
    expect(pageStartFor(10, 200_000, 5000, 40)).toBe(0)
    expect(pageStartFor(199_990, 200_000, 5000, 40)).toBe(195_000)
    expect(pageStartFor(100, 300, 5000, 40)).toBe(0)
  })
})

describe('history rail geometry', () => {
  it('hides when everything fits on screen', () => {
    expect(railThumb(0, 40, 40, 400)).toBeNull()
  })

  it('places the live view at the bottom of the track', () => {
    const thumb = railThumb(960, 40, 1000, 400)
    expect(thumb?.sizePx).toBe(18) // 40/1000 of 400px is below the minimum
    expect(thumb?.offsetPx).toBe(382)
  })

  it('maps rail fractions back to top lines', () => {
    expect(lineForFraction(0, 1000, 40)).toBe(0)
    expect(lineForFraction(1, 1000, 40)).toBe(960)
    expect(lineForFraction(2, 1000, 40)).toBe(960)
    expect(lineForFraction(0.5, 1000, 40)).toBe(480)
  })
})

describe('history selection', () => {
  it('orders a drag that ran upward', () => {
    const later = { line: 9, col: 2 }
    const earlier = { line: 3, col: 7 }
    expect(orderPoints(later, earlier)).toEqual([earlier, later])
  })

  it('copies a multi-line span with inclusive end column', () => {
    const lines = ['alpha beta   ', 'gamma', 'delta epsilon']
    expect(selectedText(lines, { line: 10, col: 6 }, { line: 12, col: 4 })).toBe(
      'beta\ngamma\ndelta',
    )
    expect(selectedText(['one two'], { line: 0, col: 0 }, { line: 0, col: 2 })).toBe('one')
  })

  it('finds word bounds for double-click', () => {
    expect(wordBounds('run ./scripts/aico-grab.sh now', 8)).toEqual([4, 25])
    expect(wordBounds('a  b', 1)).toEqual([1, 1])
  })
})
