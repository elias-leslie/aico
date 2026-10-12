import { describe, expect, it } from 'vitest'
import { urlAt } from './links'

describe('urlAt', () => {
  const line = 'Open https://192.168.86.39:8006. Then log in.'
  it('finds the URL under the column, without trailing prose punctuation', () => {
    expect(urlAt(line, 5)).toBe('https://192.168.86.39:8006')
    expect(urlAt(line, 30)).toBe('https://192.168.86.39:8006')
  })
  it('returns null off the URL', () => {
    expect(urlAt(line, 2)).toBeNull()
    expect(urlAt(line, 31)).toBeNull()
  })
  it('keeps balanced parentheses', () => {
    expect(urlAt('see https://en.wikipedia.org/wiki/Foo_(bar) now', 6)).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    )
  })
})
