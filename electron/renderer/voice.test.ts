import { describe, expect, it } from 'vitest'
import { transcriptDelta } from './voice'

describe('transcriptDelta', () => {
  it('returns the trimmed suffix that grew since the previous report', () => {
    expect(transcriptDelta('hello', 'hello world')).toBe('world')
  })

  it('returns the whole (trimmed) text on the first utterance', () => {
    expect(transcriptDelta('', '  open the file  ')).toBe('open the file')
  })

  it('falls back to the full text when it is not an extension of prev', () => {
    expect(transcriptDelta('old transcript', 'fresh start')).toBe('fresh start')
  })

  it('yields empty when nothing new was appended', () => {
    expect(transcriptDelta('same', 'same')).toBe('')
  })
})
