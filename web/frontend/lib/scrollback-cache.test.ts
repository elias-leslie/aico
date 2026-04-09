import { describe, expect, it } from 'vitest'
import { ScrollbackLineCache } from './scrollback-cache'

describe('ScrollbackLineCache', () => {
  it('stores and retrieves lines', () => {
    const cache = new ScrollbackLineCache()
    cache.setLines(100, ['line1', 'line2', 'line3'])
    expect(cache.getLine(100)?.content).toBe('line1')
    expect(cache.getLine(101)?.content).toBe('line2')
    expect(cache.getLine(102)?.content).toBe('line3')
    expect(cache.getLine(99)).toBeUndefined()
  })

  it('checks range availability', () => {
    const cache = new ScrollbackLineCache()
    cache.setLines(0, ['a', 'b', 'c'])
    expect(cache.hasRange(0, 3)).toBe(true)
    expect(cache.hasRange(0, 4)).toBe(false)
  })

  it('deduplicates pending requests', () => {
    const cache = new ScrollbackLineCache()
    expect(cache.isRequestPending(0, 100)).toBe(false)
    cache.markRequestPending(0, 100)
    expect(cache.isRequestPending(0, 100)).toBe(true)
    // Setting lines clears the pending request
    cache.setLines(
      0,
      Array.from({ length: 100 }, (_, i) => `line${i}`),
    )
    expect(cache.isRequestPending(0, 100)).toBe(false)
  })

  it('evicts LRU entries when max exceeded', () => {
    const cache = new ScrollbackLineCache(5)
    cache.setLines(0, ['a', 'b', 'c', 'd', 'e'])
    expect(cache.size).toBe(5)
    // Add one more — should evict oldest
    cache.setLines(5, ['f'])
    expect(cache.size).toBe(5)
  })

  it('clears all data', () => {
    const cache = new ScrollbackLineCache()
    cache.setLines(0, ['a', 'b'])
    cache.markRequestPending(10, 50)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.isRequestPending(10, 50)).toBe(false)
  })

  it('updates accessedAt on get', () => {
    const cache = new ScrollbackLineCache()
    cache.setLines(0, ['a', 'b'])
    const entry = cache.getLine(0)
    expect(entry).toBeDefined()
    expect(entry!.accessedAt).toBeGreaterThan(0)
  })
})
