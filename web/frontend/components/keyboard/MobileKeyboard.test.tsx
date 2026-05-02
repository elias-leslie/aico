import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileKeyboard } from './MobileKeyboard'

vi.mock('./ControlBar', () => ({
  ControlBar: ({
    minimized,
    onToggleMinimize,
  }: {
    minimized: boolean
    onToggleMinimize: () => void
  }) => (
    <div>
      <span>{minimized ? 'minimized' : 'expanded'}</span>
      <button onClick={onToggleMinimize}>toggle minimize</button>
    </div>
  ),
}))

vi.mock('./FullKeyboard', () => ({
  FullKeyboard: () => <div data-testid="full-keyboard">keyboard</div>,
}))

vi.mock('./NativeKeyboardInput', () => ({
  NativeKeyboardInput: () => (
    <div data-testid="native-keyboard-input">native</div>
  ),
}))

describe('MobileKeyboard', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('hydrates legacy minimized state from storage', () => {
    window.localStorage.setItem('a-term-keyboard-minimized', 'true')

    render(<MobileKeyboard onSend={vi.fn()} />)

    expect(screen.getByText('minimized')).toBeInTheDocument()
    expect(screen.queryByTestId('full-keyboard')).not.toBeInTheDocument()
  })

  it('persists minimize toggles through the shared storage hook', () => {
    render(<MobileKeyboard onSend={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'toggle minimize' }))

    expect(screen.getByText('minimized')).toBeInTheDocument()
    expect(window.localStorage.getItem('a-term-keyboard-minimized')).toBe(
      'true',
    )
  })

  it('renders native ribbon input instead of the custom keyboard in native mode', () => {
    render(<MobileKeyboard onSend={vi.fn()} keyboardMode="native" />)

    expect(screen.getByTestId('native-keyboard-input')).toBeInTheDocument()
    expect(screen.queryByTestId('full-keyboard')).not.toBeInTheDocument()
  })

  it('lets the voice panel own bottom safe-area padding while voice is active', () => {
    const { container } = render(
      <MobileKeyboard onSend={vi.fn()} voiceActive={true} />,
    )

    expect((container.firstChild as HTMLElement).style.paddingBottom).toBe(
      '0px',
    )
  })
})
