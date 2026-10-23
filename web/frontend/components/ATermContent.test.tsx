import { fireEvent, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATermContent, type ATermContentProps } from './ATermContent'

vi.mock('./AgentShowToast', () => ({ AgentShows: () => null }))
vi.mock('./SettingsDropdown', () => ({ SettingsDropdown: () => null }))
vi.mock('./a-term-content/ATermMobileSection', () => ({
  ATermMobileSection: () => null,
}))
vi.mock('./a-term-content/ATermFileSection', () => ({
  ATermFileSection: ({
    composeOpen,
    onToggleCompose,
  }: {
    composeOpen?: boolean
    onToggleCompose?: () => void
  }) =>
    onToggleCompose ? (
      <button
        type="button"
        aria-pressed={composeOpen}
        onClick={onToggleCompose}
      >
        Compose
      </button>
    ) : null,
}))
vi.mock('./keyboard/NativeKeyboardInput', () => ({
  NativeKeyboardInput: ({
    inputRef,
  }: {
    inputRef?: RefObject<HTMLTextAreaElement | null>
  }) => <textarea aria-label="Compose box" ref={inputRef} />,
}))

const props = {
  isMobile: false,
  activeSessionId: 'session-a',
  sessions: [{ id: 'session-a' }],
  activeStatus: 'connected',
} as unknown as ATermContentProps

describe('ATermContent compose box', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('on a desktop, stays hidden until Compose opens it, then is remembered', () => {
    const first = render(<ATermContent {...props} />)
    expect(screen.queryByRole('textbox', { name: 'Compose box' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    const box = screen.getByRole('textbox', { name: 'Compose box' })
    expect(box).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Compose' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    first.unmount()

    render(<ATermContent {...props} />)
    expect(
      screen.getByRole('textbox', { name: 'Compose box' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    expect(screen.queryByRole('textbox', { name: 'Compose box' })).toBeNull()
  })

  it('still opens when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<ATermContent {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    expect(
      screen.getByRole('textbox', { name: 'Compose box' }),
    ).toBeInTheDocument()
  })

  it('on a phone, offers no Compose button (the phone always shows its own box)', () => {
    render(<ATermContent {...props} isMobile />)
    expect(screen.queryByRole('button', { name: 'Compose' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Compose box' })).toBeNull()
  })
})
