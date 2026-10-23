import { fireEvent, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalContent, type TerminalContentProps } from './TerminalContent'

const media = vi.hoisted(() => ({ wide: false }))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => media.wide,
}))
vi.mock('./SessionSidebar', () => ({
  SessionSidebar: ({ currentId }: { currentId?: string }) => (
    <nav aria-label="Session list">{currentId}</nav>
  ),
}))
vi.mock('./AgentShowToast', () => ({ AgentShows: () => null }))
vi.mock('./terminal-content/TerminalMobileSection', () => ({
  TerminalMobileSection: () => null,
}))
vi.mock('./terminal-content/TerminalFileSection', () => ({
  TerminalFileSection: ({
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
  terminalSlots: [],
  activeStatus: 'connected',
} as unknown as TerminalContentProps

describe('TerminalContent compose box', () => {
  beforeEach(() => {
    window.localStorage.clear()
    media.wide = false
  })
  afterEach(() => vi.restoreAllMocks())

  it('on a desktop, stays hidden until Compose opens it, then is remembered', () => {
    const first = render(<TerminalContent {...props} />)
    expect(screen.queryByRole('textbox', { name: 'Compose box' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    const box = screen.getByRole('textbox', { name: 'Compose box' })
    expect(box).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Compose' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    first.unmount()

    render(<TerminalContent {...props} />)
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
    render(<TerminalContent {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    expect(
      screen.getByRole('textbox', { name: 'Compose box' }),
    ).toBeInTheDocument()
  })

  it('on a phone, offers no Compose button (the phone always shows its own box)', () => {
    render(<TerminalContent {...props} isMobile />)
    expect(screen.queryByRole('button', { name: 'Compose' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Compose box' })).toBeNull()
  })

  it('puts the session list beside the session in a wide desktop window', () => {
    media.wide = true
    const { rerender } = render(<TerminalContent {...props} />)
    expect(
      screen.getByRole('navigation', { name: 'Session list' }),
    ).toBeVisible()

    rerender(<TerminalContent {...props} isMobile />)
    expect(
      screen.queryByRole('navigation', { name: 'Session list' }),
    ).toBeNull()

    media.wide = false
    rerender(<TerminalContent {...props} />)
    expect(
      screen.queryByRole('navigation', { name: 'Session list' }),
    ).toBeNull()
  })
})
