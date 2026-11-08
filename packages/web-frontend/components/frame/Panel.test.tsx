import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Panel } from './Panel'

const state = vi.hoisted(() => ({
  open: vi.fn(),
  phone: false,
  tier: 'panel',
}))
vi.mock('./FrameContext', () => ({
  useFrame: () => ({
    open: state.open,
    docked: !state.phone,
    tier: state.tier,
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

// Each section has its own tests; here only how the Panel lays them out.
vi.mock('../asks/NeedsYou', () => ({
  NeedsYouSection: () => <section aria-label="Needs you" />,
}))
vi.mock('./SystemSection', () => ({
  SystemSection: () => <section aria-label="System" />,
}))
vi.mock('./ProjectsSection', () => ({
  ProjectsSection: () => (
    <section aria-label="Projects">
      <nav aria-label="Sessions" />
    </section>
  ),
}))
vi.mock('./QuotaMeter', () => ({
  QuotaMeter: () => (
    <button type="button" aria-label="Quota: Claude 82% left">
      82%
    </button>
  ),
}))

const slots = [] as never[]

describe('Panel', () => {
  beforeEach(() => {
    localStorage.clear()
    state.phone = false
    state.tier = 'panel'
    state.open.mockClear()
  })

  it('lists Needs you, System, then Projects, in that order', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(
      screen
        .getAllByRole('region')
        .map((section) => section.getAttribute('aria-label')),
    ).toEqual(['Needs you', 'System', 'Projects'])
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeVisible()
  })

  it('pins the Quota meter and Settings in the footer, with no Notes or Capture', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    const foot = screen.getByRole('button', { name: /^Quota/ }).parentElement
    expect(
      within(foot as HTMLElement)
        .getAllByRole('button')
        .map(
          (button) => button.getAttribute('aria-label') ?? button.textContent,
        ),
    ).toEqual(['Quota: Claude 82% left', 'Settings'])
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Capture/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    )
  })

  it('opens a menu above the gear with the five setup places, each opening its page in place, no badge', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const menu = screen.getByRole('menu', { name: 'Settings' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Logins', 'Grants', 'Recovery', 'Context', 'Phone app'])
    expect(screen.getByRole('menuitem', { name: 'Logins' })).toHaveFocus()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Recovery' }))
    expect(state.open).toHaveBeenCalledWith('/recovery')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes the menu on Escape and returns focus to the gear', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    const gear = screen.getByRole('button', { name: 'Settings' })
    fireEvent.click(gear)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(gear).toHaveFocus()
  })

  it('on a phone the gear opens a Settings page in the sheet, with Back to the list', () => {
    state.phone = true
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeNull()
    const places = screen.getByRole('navigation', { name: 'Settings places' })
    expect(within(places).getAllByRole('link')).toHaveLength(5)
    expect(within(places).getByText('agent sign-ins')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(
      within(
        screen.getByRole('navigation', { name: 'Settings places' }),
      ).getByRole('link', { name: /Grants/ }),
    )
    expect(state.open).toHaveBeenLastCalledWith('/grants')
  })
})
