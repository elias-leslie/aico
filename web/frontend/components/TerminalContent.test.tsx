import { fireEvent, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalContent, type TerminalContentProps } from './TerminalContent'

const media = vi.hoisted(() => ({ wide: false }))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => media.wide,
}))
vi.mock('./SessionSidebar', () => ({
  SIDE_LIST_WIDTH: { initial: 320 },
  SessionSidebar: ({
    currentId,
    collapsed,
    onCollapsedChange,
    width,
    onWidthChange,
  }: {
    currentId?: string
    collapsed?: boolean
    onCollapsedChange?: (collapsed: boolean) => void
    width?: number
    onWidthChange?: (width: number) => void
  }) => (
    <nav aria-label="Session list">
      {currentId}
      <p>{collapsed ? 'Rail' : `List ${width}px`}</p>
      <button type="button" onClick={() => onCollapsedChange?.(!collapsed)}>
        {collapsed ? 'Expand' : 'Collapse'}
      </button>
      <button type="button" onClick={() => onWidthChange?.(400)}>
        Widen
      </button>
    </nav>
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
    sideList,
  }: {
    composeOpen?: boolean
    onToggleCompose?: () => void
    sideList?: boolean
  }) => (
    <>
      {onToggleCompose && (
        <button
          type="button"
          aria-pressed={composeOpen}
          onClick={onToggleCompose}
        >
          Compose
        </button>
      )}
      {sideList && <p>Bar without its own switcher</p>}
    </>
  ),
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

  it('folds the list to its rail and keeps its width, remembered on this device', () => {
    media.wide = true
    const { unmount } = render(<TerminalContent {...props} />)
    expect(screen.getByText('List 320px')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Widen' }))
    expect(screen.getByText('List 400px')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(screen.getByText('Rail')).toBeVisible()
    // The rail switches sessions, so the bar still has no switcher.
    expect(screen.getByText('Bar without its own switcher')).toBeVisible()
    unmount()

    render(<TerminalContent {...props} />)
    expect(screen.getByText('Rail')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(screen.getByText('List 400px')).toBeVisible()
  })

  it('shows no list or rail when the window is too narrow, folded or not', () => {
    window.localStorage.setItem('aico-side-list-hidden', 'true')
    render(<TerminalContent {...props} />)
    expect(
      screen.queryByRole('navigation', { name: 'Session list' }),
    ).toBeNull()
    expect(screen.queryByText('Bar without its own switcher')).toBeNull()
  })
})
