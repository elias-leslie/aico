import { describe, expect, it } from 'vitest'
import {
  getTranscriptAppendSuffix,
  mergeTranscriptSegments,
  normalizeTranscript,
} from './transcript-merge'

describe('transcript merge helpers', () => {
  it('normalizes whitespace', () => {
    expect(normalizeTranscript('  hello   world  ')).toBe('hello world')
  })

  it('appends only the non-overlapping suffix from cumulative phrases', () => {
    expect(getTranscriptAppendSuffix('hello', 'hello world')).toBe('world')
    expect(getTranscriptAppendSuffix('hello world', 'world again')).toBe(
      'again',
    )
  })

  it('merges repeated browser speech chunks without duplicated words', () => {
    expect(
      mergeTranscriptSegments(['hello', 'hello world', 'world again']),
    ).toBe('hello world again')
  })
})
