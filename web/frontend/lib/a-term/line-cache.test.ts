import { describe, expect, it } from 'vitest'
import type { ScrollbackDelta } from './line-cache'
import { LineCache } from './line-cache'

describe('LineCache', () => {
  it('applies a delta with changes', () => {
    const cache = new LineCache()
    const delta: ScrollbackDelta = {
      seqno: 1,
      base: 0,
      changes: [
        [0, '$ ls'],
        [1, 'file1  file2'],
      ],
      removals: [],
      total_lines: 2,
    }
    expect(cache.applyDelta(delta)).toBe(true)
    expect(cache.size).toBe(2)
  })

  it('rejects stale seqno', () => {
    const cache = new LineCache()
    cache.applyDelta({
      seqno: 5,
      base: 0,
      changes: [[0, 'line']],
      removals: [],
      total_lines: 1,
    })
    const stale = cache.applyDelta({
      seqno: 3,
      base: 0,
      changes: [[0, 'old']],
      removals: [],
      total_lines: 1,
    })
    expect(stale).toBe(false)
  })

  it('handles removals', () => {
    const cache = new LineCache()
    cache.applyDelta({
      seqno: 1,
      base: 0,
      changes: [
        [0, 'a'],
        [1, 'b'],
        [2, 'c'],
      ],
      removals: [],
      total_lines: 3,
    })
    expect(cache.size).toBe(3)

    cache.applyDelta({
      seqno: 2,
      base: 1,
      changes: [],
      removals: [0],
      total_lines: 2,
    })
    expect(cache.size).toBe(2)
  })

  it('reconstructs full content from cache', () => {
    const cache = new LineCache()
    cache.applyDelta({
      seqno: 1,
      base: 0,
      changes: [
        [0, 'line1'],
        [1, 'line2'],
        [2, 'line3'],
      ],
      removals: [],
      total_lines: 3,
    })
    const content = cache.toFullContent()
    expect(content).toBe('line1\r\nline2\r\nline3')
  })

  it('resets state', () => {
    const cache = new LineCache()
    cache.applyDelta({
      seqno: 1,
      base: 0,
      changes: [[0, 'data']],
      removals: [],
      total_lines: 1,
    })
    cache.reset()
    expect(cache.size).toBe(0)
    // After reset, seqno 1 should be accepted again
    expect(
      cache.applyDelta({
        seqno: 1,
        base: 0,
        changes: [[0, 'new']],
        removals: [],
        total_lines: 1,
      }),
    ).toBe(true)
  })
})
