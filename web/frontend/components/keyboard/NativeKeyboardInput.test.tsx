import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  getNativeKeyboardDelta,
  NativeKeyboardInput,
} from './NativeKeyboardInput'

describe('getNativeKeyboardDelta', () => {
  it('detects appended text', () => {
    expect(getNativeKeyboardDelta('hel', 'hello')).toEqual({
      backspaces: 0,
      insertedText: 'lo',
    })
  })

  it('detects replacements from autocomplete corrections', () => {
    expect(getNativeKeyboardDelta('hte ', 'the ')).toEqual({
      backspaces: 2,
      insertedText: 'th',
    })
  })
})

describe('NativeKeyboardInput', () => {
  it('sends inserted text and backspaces from native input edits', () => {
    const onSend = vi.fn()

    render(<NativeKeyboardInput onSend={onSend} />)

    const input = screen.getByLabelText('Native Keyboard')
    fireEvent.change(input, { target: { value: 'hel' } })
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.change(input, { target: { value: 'hell' } })

    expect(onSend).toHaveBeenNthCalledWith(1, 'hel')
    expect(onSend).toHaveBeenNthCalledWith(2, 'lo')
    expect(onSend).toHaveBeenNthCalledWith(3, '\x7f')
  })

  it('maps Enter to carriage return and clears the compose field', () => {
    const onSend = vi.fn()

    render(<NativeKeyboardInput onSend={onSend} />)

    const input = screen.getByLabelText('Native Keyboard') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ls -la' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).toHaveBeenNthCalledWith(1, 'ls -la')
    expect(onSend).toHaveBeenNthCalledWith(2, '\r')
    expect(input.value).toBe('')
  })
})
