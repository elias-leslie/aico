import { describe, expect, it } from 'vitest'
import { moveComposeCaret } from './composeNavigation'

function draft(value: string, position: number): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  input.setSelectionRange(position, position)
  return input
}

describe('moveComposeCaret', () => {
  it('moves left and right within a draft without changing the text', () => {
    const input = draft('answer', 6)

    expect(moveComposeCaret(input, 'left', false)).toBe(true)
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5])
    expect(moveComposeCaret(input, 'right', false)).toBe(true)
    expect([input.selectionStart, input.selectionEnd]).toEqual([6, 6])
    expect(input.value).toBe('answer')
  })

  it('extends and then collapses a Shift+Left selection', () => {
    const input = draft('answer', 6)

    moveComposeCaret(input, 'left', true)
    moveComposeCaret(input, 'left', true)
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 6])
    expect(input.selectionDirection).toBe('backward')

    moveComposeCaret(input, 'right', false)
    expect([input.selectionStart, input.selectionEnd]).toEqual([6, 6])
  })

  it('leaves terminal navigation available for empty drafts and up/down', () => {
    const input = draft('', 0)
    expect(moveComposeCaret(input, 'left', true)).toBe(false)
    input.value = 'answer'
    expect(moveComposeCaret(input, 'up', false)).toBe(false)
  })

  it('moves and extends a textarea selection without changing its draft', () => {
    const input = document.createElement('textarea')
    input.value = 'one two'
    input.setSelectionRange(7, 7)

    expect(moveComposeCaret(input, 'left', true)).toBe(true)
    expect([input.selectionStart, input.selectionEnd]).toEqual([6, 7])
    expect(moveComposeCaret(input, 'right', false)).toBe(true)
    expect([input.selectionStart, input.selectionEnd]).toEqual([7, 7])
    expect(input.value).toBe('one two')
  })
})
