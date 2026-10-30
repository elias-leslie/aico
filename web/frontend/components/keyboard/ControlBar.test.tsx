import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ControlBar } from './ControlBar'
import { CLEAR_PROMPT } from './keyMappings'

function renderControlBar(
  overrides: Partial<ComponentProps<typeof ControlBar>> = {},
) {
  const onSend = vi.fn()
  render(
    <ControlBar
      onSend={onSend}
      ctrlActive={false}
      onCtrlToggle={vi.fn()}
      keyboardOpen={false}
      onToggleKeyboard={vi.fn()}
      {...overrides}
    />,
  )
  return { onSend }
}

describe('ControlBar', () => {
  it('has only the keys a phone keyboard lacks', () => {
    renderControlBar()
    expect(
      screen.getAllByRole('button').map((button) => button.ariaLabel),
    ).toEqual([
      'Show keyboard',
      'Esc',
      'Tab',
      'Ctrl',
      'Left',
      'Up',
      'Down',
      'Right',
      'Enter',
      'Clear prompt',
    ])
  })

  it('sends each key', () => {
    const { onSend } = renderControlBar()
    const press = (name: string) =>
      fireEvent.click(screen.getByRole('button', { name }))
    press('Esc')
    press('Tab')
    press('Up')
    press('Left')
    press('Enter')
    press('Clear prompt')
    expect(onSend.mock.calls.map(([sequence]) => sequence)).toEqual([
      '\x1b',
      '\t',
      '\x1b[A',
      '\x1b[D',
      '\r',
      CLEAR_PROMPT,
    ])
  })

  it('sends Ctrl+arrow while Ctrl is held', () => {
    const { onSend } = renderControlBar({ ctrlActive: true })
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Right' }))
    expect(onSend).toHaveBeenCalledWith('\x1b[1;5C')
  })

  it('keeps the keyboard open when a key is pressed', () => {
    renderControlBar({ keyboardOpen: true })
    for (const button of screen.getAllByRole('button'))
      expect(fireEvent.pointerDown(button)).toBe(false)
    expect(
      screen.getByRole('button', { name: 'Hide keyboard' }),
    ).toBeInTheDocument()
  })
})
