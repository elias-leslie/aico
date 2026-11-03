import { describe, expect, it } from 'vitest'
import { caretMoves, editKeys, typingEdit } from './phoneTyping'

describe('typingEdit', () => {
  it('types a letter at the end', () => {
    expect(typingEdit('hel', 'hell', 3, 4)).toEqual({
      move: 0,
      deletes: 0,
      insert: 'l',
      caret: 4,
    })
  })

  it('backspaces one character, even one of a pair', () => {
    expect(typingEdit('hell', 'hel', 4, 3)).toEqual({
      move: 0,
      deletes: 1,
      insert: '',
      caret: 3,
    })
  })

  it('edits at the caret when the cursor was moved back', () => {
    // "aa" with the caret between the letters, another "a" typed there.
    expect(typingEdit('aa', 'aaa', 1, 2)).toEqual({
      move: 0,
      deletes: 0,
      insert: 'a',
      caret: 2,
    })
  })

  it('replaces a word the keyboard swapped', () => {
    const edit = typingEdit('the wrold', 'the world', 9, 9)
    expect(edit).toEqual({ move: 0, deletes: 4, insert: 'orld', caret: 9 })
    expect(editKeys(edit)).toBe('\x7f'.repeat(4))
  })

  it('counts an emoji as one character', () => {
    expect(typingEdit('hi 👋', 'hi ', 4, 3)).toEqual({
      move: 0,
      deletes: 1,
      insert: '',
      caret: 3,
    })
  })

  it('replaces a selection', () => {
    // "abc" with "b" selected (session cursor after it), "x" typed.
    const edit = typingEdit('abc', 'axc', 2, 2)
    expect(edit).toEqual({ move: 0, deletes: 1, insert: 'x', caret: 2 })
  })
})

describe('caretMoves', () => {
  it('sends arrows for a cursor drag', () => {
    expect(caretMoves(-2)).toBe('\x1b[D\x1b[D')
    expect(caretMoves(1)).toBe('\x1b[C')
    expect(caretMoves(0)).toBe('')
  })
})
