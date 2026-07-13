import { describe, expect, it } from 'vitest'
import { sanitizeVoiceTranscript, transcriptDelta, VOICE_TRANSCRIPT_MAX_CODE_POINTS } from './voice'

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

describe('sanitizeVoiceTranscript', () => {
  it('turns newlines and terminal controls into non-submitting spaces', () => {
    expect(sanitizeVoiceTranscript('echo safe\r\n\u001b[31mstill editable\u009b2J')).toBe(
      'echo safe [31mstill editable 2J',
    )
  })

  it('preserves printable shell metacharacters without appending Enter', () => {
    const text = sanitizeVoiceTranscript('printf "%s" "$HOME"; echo done')
    expect(text).toBe('printf "%s" "$HOME"; echo done')
    expect(text).not.toMatch(/[\r\n]/)
  })

  it('caps a single transcript by Unicode code point without splitting a character', () => {
    const text = sanitizeVoiceTranscript(`🧰${'a'.repeat(VOICE_TRANSCRIPT_MAX_CODE_POINTS)}`)
    expect(Array.from(text)).toHaveLength(VOICE_TRANSCRIPT_MAX_CODE_POINTS)
    expect(text.startsWith('🧰')).toBe(true)
  })
})
