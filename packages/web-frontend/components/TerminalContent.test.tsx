import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode, RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalContent, type TerminalContentProps } from './TerminalContent'

const media = vi.hoisted(() => ({ wide: false }))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => media.wide,
}))
const frame = vi.hoisted(() => ({
  current: null as null | {
    docked: boolean
    tier: string
    setTier: (tier: string) => void
    setSheetOpen: (open: boolean) => void
  },
}))
vi.mock('./frame/FrameContext', () => ({ useFrame: () => frame.current }))
vi.mock('./frame/LeftSide', () => ({
  LeftSide: ({ rail, panel }: { rail: ReactNode; panel: ReactNode }) =>
    frame.current?.tier === 'rail' ? rail : panel,
}))
vi.mock('./frame/WideStatus', () => ({ WideStatus: () => null }))
vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => ({
    forSlot: () => null,
    asksFor: () => ({ blocking: 0, other: 0 }),
    needsYouCount: 0,
  }),
}))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ agentTools: [] }),
}))
vi.mock('./frame/Panel', () => ({
  Panel: ({ onSelect }: { onSelect: (slot: unknown) => void }) => (
    <nav aria-label="Session list">
      <p>List</p>
      <button
        type="button"
        onClick={() => onSelect({ type: 'terminal', sessionId: 'session-b' })}
      >
        Pick session b
      </button>
    </nav>
  ),
}))
vi.mock('./frame/Rail', () => ({
  Rail: ({ onSelect }: { onSelect: (slot: unknown) => void }) => (
    <nav aria-label="Session list">
      <p>Rail</p>
      <button
        type="button"
        onClick={() => onSelect({ type: 'terminal', sessionId: 'session-b' })}
      >
        Pick session b
      </button>
    </nav>
  ),
}))
vi.mock('./AgentShowToast', () => ({ AgentShows: () => null }))
vi.mock('./asks/SessionAsk', () => ({ SessionAsk: () => null }))
vi.mock('./terminal-content/TerminalMobileSection', () => ({
  TerminalMobileSection: () => <div data-testid="phone-key-row" />,
}))
vi.mock('./terminal-content/TerminalFileSection', () => ({
  TerminalFileSection: ({
    composeOpen,
    onToggleCompose,
  }: {
    composeOpen?: boolean
    onToggleCompose?: () => void
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
    frame.current = null
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

  it('on a phone, shows the key row only while a session is open', () => {
    const { rerender } = render(<TerminalContent {...props} isMobile />)
    expect(screen.queryByTestId('phone-key-row')).toBeNull()
    rerender(
      <TerminalContent
        {...props}
        isMobile
        terminalSlots={
          [
            { type: 'terminal', sessionId: 'session-a' },
          ] as unknown as TerminalContentProps['terminalSlots']
        }
      />,
    )
    expect(screen.getByTestId('phone-key-row')).toBeInTheDocument()
  })

  it('puts the panel or rail beside the session', () => {
    frame.current = {
      docked: true,
      tier: 'panel',
      setTier: vi.fn(),
      setSheetOpen: vi.fn(),
    }
    const { rerender } = render(<TerminalContent {...props} />)
    expect(screen.getByText('List')).toBeVisible()
    frame.current = { ...frame.current, tier: 'rail' }
    rerender(<TerminalContent {...props} />)
    expect(screen.getByText('Rail')).toBeVisible()
  })

  it('at Full keeps the session out of reach, and picking a session returns to Panel', () => {
    const setTier = vi.fn()
    const onSlotSwitch = vi.fn()
    frame.current = {
      docked: true,
      tier: 'full',
      setTier,
      setSheetOpen: vi.fn(),
    }
    render(<TerminalContent {...props} onSlotSwitch={onSlotSwitch} />)
    expect(screen.getByTestId('session-side')).toHaveAttribute('inert')
    fireEvent.click(screen.getByRole('button', { name: 'Pick session b' }))
    expect(onSlotSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-b' }),
    )
    expect(setTier).toHaveBeenCalledWith('panel')
  })

  it('on a narrow window, picking a session closes the slide-over and keeps the width', () => {
    const setSheetOpen = vi.fn()
    const setTier = vi.fn()
    frame.current = { docked: false, tier: 'panel', setTier, setSheetOpen }
    render(<TerminalContent {...props} onSlotSwitch={vi.fn()} />)
    expect(screen.getByTestId('session-side')).not.toHaveAttribute('inert')
    // The first render leaves a page's sheet (a /needs-you link) open.
    expect(setSheetOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pick session b' }))
    expect(setSheetOpen).toHaveBeenCalledWith(false)
    expect(setTier).not.toHaveBeenCalled()
  })
})
