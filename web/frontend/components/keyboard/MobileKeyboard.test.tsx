import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MobileKeyboard } from './MobileKeyboard'

function setup() {
  const onSend = vi.fn()
  const onPaste = vi.fn()
  const view = render(
    <MobileKeyboard sessionId="s1" onSend={onSend} onPaste={onPaste} />,
  )
  const field = screen.getByLabelText(
    'Type into the session',
  ) as HTMLTextAreaElement
  // What the phone keyboard does to the field: a new value, caret at its end.
  const type = (value: string) => {
    field.value = value
    fireEvent.input(field)
  }
  const sent = () => onSend.mock.calls.map(([data]) => data).join('')
  return { ...view, field, onSend, onPaste, type, sent }
}

describe('MobileKeyboard', () => {
  it('asks the keyboard for plain typing: no autocorrect, capitals or predictions', () => {
    const { field } = setup()
    expect(field).toHaveAttribute('autocorrect', 'off')
    expect(field).toHaveAttribute('autocapitalize', 'off')
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(field).toHaveAttribute('spellcheck', 'false')
    expect(screen.queryByRole('button', { name: /send|insert/i })).toBeNull()
  })

  it('types each letter straight into the session', () => {
    const { type, sent } = setup()
    type('l')
    type('ls')
    type('ls ')
    expect(sent()).toBe('ls ')
  })

  it('backspaces in the session, also past what this field holds', () => {
    const { field, type, sent, onSend } = setup()
    type('ab')
    type('a')
    type('')
    expect(fireEvent.keyDown(field, { key: 'Backspace' })).toBe(false)
    expect(sent()).toBe('ab\x7f\x7f\x7f')
    onSend.mockClear()
    // With text before the caret the keyboard's own edit is the backspace.
    type('x')
    expect(fireEvent.keyDown(field, { key: 'Backspace' })).toBe(true)
    expect(sent()).toBe('x')
  })

  it('runs the line only on Enter and starts the field fresh', () => {
    const { field, type, sent } = setup()
    type('echo hi')
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false)
    expect(sent()).toBe('echo hi\r')
    expect(field.value).toBe('')
  })

  it('sends a keyboard-inserted line break as Enter', () => {
    const { field, type, sent } = setup()
    type('hi')
    type('hi\n')
    expect(sent()).toBe('hi\r')
    expect(field.value).toBe('')
  })

  it('pastes as one block and types nothing', () => {
    const { field, onPaste, sent } = setup()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, {
      clipboardData: {
        items: [],
        files: [],
        getData: () => 'line one\nline two',
      },
    })
    field.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(onPaste).toHaveBeenCalledExactlyOnceWith('line one\nline two')
    expect(sent()).toBe('')
  })

  it('pastes several lines the keyboard inserts at once', () => {
    const { type, onPaste, sent } = setup()
    type('a')
    type('aone\ntwo')
    expect(sent()).toBe('a')
    expect(onPaste).toHaveBeenCalledExactlyOnceWith('one\ntwo')
  })

  it('sends Ctrl+letter once with Ctrl held, without typing the letter', () => {
    const { field, type, sent } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }))
    type('c')
    expect(sent()).toBe('\x03')
    expect(field.value).toBe('')
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    type('c')
    expect(sent()).toBe('\x03c')
  })

  it('starts the field fresh after a key-row key', () => {
    const { field, type, sent } = setup()
    type('ab')
    fireEvent.click(screen.getByRole('button', { name: 'Up' }))
    expect(field.value).toBe('')
    type('c')
    expect(sent()).toBe('ab\x1b[Ac')
  })

  it('shows and hides the phone keyboard from the key row', () => {
    const { field } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }))
    expect(document.activeElement).toBe(field)
    fireEvent.click(screen.getByRole('button', { name: 'Hide keyboard' }))
    expect(document.activeElement).not.toBe(field)
  })
})
