import { fireEvent, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MobileKeyboard } from './MobileKeyboard'

vi.mock('./ControlBar', () => ({
  ControlBar: ({
    minimized,
    onToggleMinimize,
    onArrow,
  }: {
    minimized: boolean
    onToggleMinimize: () => void
    onArrow?: (
      direction: 'left',
      modifiers: { shift: boolean; ctrl: boolean; alt: boolean },
    ) => boolean
  }) => (
    <div>
      <span>{minimized ? 'keyboard hidden' : 'keyboard shown'}</span>
      <button type="button" onClick={onToggleMinimize}>
        toggle keyboard
      </button>
      <button
        type="button"
        onClick={() =>
          onArrow?.('left', { shift: true, ctrl: false, alt: false })
        }
      >
        shift left
      </button>
    </div>
  ),
}))

vi.mock('./NativeKeyboardInput', () => ({
  isComposePending: () => false,
  NativeKeyboardInput: ({
    inputRef,
    onFocusChange,
  }: {
    inputRef: RefObject<HTMLInputElement | null>
    onFocusChange: (focused: boolean) => void
  }) => (
    <input
      data-testid="compose"
      ref={inputRef}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
    />
  ),
}))

describe('MobileKeyboard', () => {
  const composeProps = {
    sessionId: 'one',
    onCompose: vi.fn().mockResolvedValue(true),
  }

  it('shows the compose box with the phone keyboard hidden at first', () => {
    render(<MobileKeyboard onSend={vi.fn()} {...composeProps} />)

    expect(screen.getByTestId('compose')).toBeInTheDocument()
    expect(screen.getByText('keyboard hidden')).toBeInTheDocument()
  })

  it('shows and hides the phone keyboard by focusing the compose box', () => {
    render(<MobileKeyboard onSend={vi.fn()} {...composeProps} />)
    const toggle = screen.getByRole('button', { name: 'toggle keyboard' })

    fireEvent.click(toggle)
    expect(screen.getByTestId('compose')).toHaveFocus()
    expect(screen.getByText('keyboard shown')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.getByTestId('compose')).not.toHaveFocus()
    expect(screen.getByText('keyboard hidden')).toBeInTheDocument()
  })

  it('moves the compose selection when Shift+Left is tapped', () => {
    const onSend = vi.fn()
    render(<MobileKeyboard onSend={onSend} {...composeProps} />)
    const input = screen.getByTestId('compose') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'answer' } })
    input.setSelectionRange(6, 6)

    fireEvent.click(screen.getByRole('button', { name: 'shift left' }))

    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 6])
    expect(onSend).not.toHaveBeenCalled()
  })

  it('hides the compose box and lets the voice panel own bottom padding while voice is active', () => {
    const { container } = render(
      <MobileKeyboard onSend={vi.fn()} voiceActive={true} {...composeProps} />,
    )

    expect(screen.queryByTestId('compose')).not.toBeInTheDocument()
    expect((container.firstChild as HTMLElement).style.paddingBottom).toBe(
      '0px',
    )
  })
})
