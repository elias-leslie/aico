import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from './FrameContext'
import { SideEdgeButton } from './SideEdgeButton'

const state = vi.hoisted(() => ({
  frame: null as Partial<Frame> | null,
  count: 0,
  known: true,
}))
vi.mock('./FrameContext', () => ({ useFrame: () => state.frame }))
vi.mock('@/lib/hooks/use-needs-you', () => ({
  useNeedsYouCounts: () => ({ count: state.count, known: state.known }),
}))

const frame = (patch: Partial<Frame> = {}): Partial<Frame> => ({
  docked: true,
  tier: 'hidden',
  setTier: vi.fn(),
  setSheetOpen: vi.fn(),
  ...patch,
})

beforeEach(() => {
  state.frame = frame()
  state.count = 0
  state.known = true
})

describe('SideEdgeButton', () => {
  it('shows nothing while the side is beside the session', () => {
    state.frame = frame({ tier: 'rail' })
    const { container } = render(<SideEdgeButton />)
    expect(container).toBeEmptyDOMElement()
  })

  it('brings a hidden side back as the rail, with the key in its tooltip', () => {
    render(<SideEdgeButton />)
    const button = screen.getByRole('button', { name: 'Show the side' })
    expect(button).toHaveAttribute('title', 'Show the side · Alt+1')
    fireEvent.click(button)
    expect(state.frame?.setTier).toHaveBeenCalledWith('rail')
  })

  it('counts what needs you on it, only above 0', () => {
    const { rerender } = render(<SideEdgeButton />)
    expect(screen.queryByText('0')).toBeNull()
    state.count = 2
    rerender(<SideEdgeButton />)
    expect(
      screen.getByRole('button', { name: 'Show the side · 2 need you' }),
    ).toHaveTextContent('2')
  })

  it('says nothing about the count while it is unread', () => {
    state.known = false
    render(<SideEdgeButton />)
    expect(screen.getByRole('button')).toHaveAccessibleName('Show the side')
    expect(screen.getByRole('button')).toHaveTextContent('')
  })

  it('on a phone is the menu, opening the sheet, with the count', () => {
    state.frame = frame({ docked: false, tier: 'panel' })
    state.count = 3
    render(<SideEdgeButton />)
    const menu = screen.getByTestId('frame-menu')
    expect(menu).toHaveAccessibleName(
      'Sessions and everything else · 3 need you',
    )
    expect(menu).toHaveTextContent('3')
    fireEvent.click(menu)
    expect(state.frame?.setSheetOpen).toHaveBeenCalledWith(true)
  })

  it('leaves the phone menu to a bar that has its own Back', () => {
    state.frame = frame({ docked: false })
    const { container } = render(<SideEdgeButton dockedOnly />)
    expect(container).toBeEmptyDOMElement()
  })
})
