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

  it('drops a phrase the phone re-sends heard slightly differently', () => {
    const first =
      'did you fix the copy paste in Aiko desktop web terminal do I need to close it'
    const again =
      'did you fix the copy paste in Iko desktop web terminal do I need to close it'
    expect(mergeTranscriptSegments([first, again])).toBe(first)
    expect(
      mergeTranscriptSegments([
        'codex is just double-checking the proxmox',
        'codex is just double checking the proxmox interface',
      ]),
    ).toBe('codex is just double-checking the proxmox interface')
  })

  it('keeps a short or genuinely different follow-up', () => {
    expect(mergeTranscriptSegments(['yes do it', 'yes do that'])).toBe(
      'yes do it yes do that',
    )
    expect(
      mergeTranscriptSegments([
        'open the settings page',
        'then close the terminal window',
      ]),
    ).toBe('open the settings page then close the terminal window')
  })
})
