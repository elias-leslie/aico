import { describe, expect, it } from 'vitest'
import { chordLabel, WINDOW_CHORDS, windowChord } from './chords'

const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  code,
  ...mods,
})

describe('window chords', () => {
  it('reads each chord back from the key that triggers it', () => {
    for (const chord of Object.keys(WINDOW_CHORDS) as (keyof typeof WINDOW_CHORDS)[]) {
      const letter = chordLabel(chord).split('+').pop()
      expect(windowChord(key(`Key${letter}`))).toBe(chord)
    }
    expect(chordLabel('palette')).toBe('Ctrl+Shift+P')
  })

  it('needs Ctrl and Shift and nothing else', () => {
    expect(windowChord(key('KeyP', { shiftKey: false }))).toBeNull()
    expect(windowChord(key('KeyP', { ctrlKey: false }))).toBeNull()
    expect(windowChord(key('KeyP', { altKey: true }))).toBeNull()
    expect(windowChord(key('KeyP', { metaKey: true }))).toBeNull()
    expect(windowChord(key('KeyZ'))).toBeNull()
  })
})
