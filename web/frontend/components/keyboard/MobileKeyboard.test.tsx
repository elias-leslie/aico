import { fireEvent, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
      <span>{minimized ? 'minimized' : 'expanded'}</span>
      <button onClick={onToggleMinimize}>toggle minimize</button>
      <button
        onClick={() =>
          onArrow?.('left', { shift: true, ctrl: false, alt: false })
        }
      >
        shift left
      </button>
    </div>
  ),
}))

vi.mock('./FullKeyboard', () => ({
  FullKeyboard: () => <div data-testid="full-keyboard">keyboard</div>,
}))

vi.mock('./NativeKeyboardInput', () => ({
  NativeKeyboardInput: ({
    inputRef,
    onFocusChange,
  }: {
    inputRef: RefObject<HTMLInputElement | null>
    onFocusChange: (focused: boolean) => void
  }) => (
    <input
      data-testid="native-keyboard-input"
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
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('hydrates legacy minimized state from storage', () => {
    window.localStorage.setItem('a-term-keyboard-minimized', 'true')

    render(<MobileKeyboard onSend={vi.fn()} {...composeProps} />)

    expect(screen.getByText('minimized')).toBeInTheDocument()
    expect(screen.queryByTestId('full-keyboard')).not.toBeInTheDocument()
  })

  it('persists minimize toggles through the shared storage hook', () => {
    render(<MobileKeyboard onSend={vi.fn()} {...composeProps} />)

    fireEvent.click(screen.getByRole('button', { name: 'toggle minimize' }))

    expect(screen.getByText('minimized')).toBeInTheDocument()
    expect(window.localStorage.getItem('a-term-keyboard-minimized')).toBe(
      'true',
    )
  })

  it('renders native ribbon input instead of the custom keyboard in native mode', () => {
    render(
      <MobileKeyboard
        onSend={vi.fn()}
        keyboardMode="native"
        {...composeProps}
      />,
    )

    expect(screen.getByTestId('native-keyboard-input')).toBeInTheDocument()
    expect(screen.queryByTestId('full-keyboard')).not.toBeInTheDocument()
  })

  it('keeps custom typing at the terminal without a separate compose input', () => {
    render(<MobileKeyboard onSend={vi.fn()} {...composeProps} />)

    expect(screen.getByTestId('full-keyboard')).toBeInTheDocument()
    expect(
      screen.queryByTestId('native-keyboard-input'),
    ).not.toBeInTheDocument()
  })

  it('shows custom keys after leaving a focused native input', () => {
    const onSend = vi.fn()
    const { rerender } = render(
      <MobileKeyboard
        onSend={onSend}
        keyboardMode="native"
        {...composeProps}
      />,
    )
    fireEvent.focus(screen.getByTestId('native-keyboard-input'))

    rerender(
      <MobileKeyboard
        onSend={onSend}
        keyboardMode="custom"
        {...composeProps}
      />,
    )

    expect(screen.getByTestId('full-keyboard')).toBeInTheDocument()
    expect(
      screen.queryByTestId('native-keyboard-input'),
    ).not.toBeInTheDocument()
  })

  it('moves the compose selection when Shift+Left is tapped', () => {
    const onSend = vi.fn()
    render(
      <MobileKeyboard
        onSend={onSend}
        keyboardMode="native"
        {...composeProps}
      />,
    )
    const input = screen.getByTestId(
      'native-keyboard-input',
    ) as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'answer' } })
    input.setSelectionRange(6, 6)

    fireEvent.click(screen.getByRole('button', { name: 'shift left' }))

    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 6])
    expect(onSend).not.toHaveBeenCalled()
  })

  it('lets the voice panel own bottom safe-area padding while voice is active', () => {
    const { container } = render(
      <MobileKeyboard onSend={vi.fn()} voiceActive={true} {...composeProps} />,
    )

    expect((container.firstChild as HTMLElement).style.paddingBottom).toBe(
      '0px',
    )
  })
})
