import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Rail } from './Rail'

const state = vi.hoisted(() => ({
  open: vi.fn(),
  setTier: vi.fn(),
  worst: 'failed' as 'ok' | 'warn' | 'failed' | 'pending',
  chips: [{ text: '3 problems', tone: 'failed' }] as {
    text: string
    tone: string
  }[],
  groups: [{ teams: [1, 2], finished: [3] }] as unknown[],
}))
vi.mock('./FrameContext', () => ({
  useFrame: () => ({
    open: state.open,
    setTier: state.setTier,
    docked: true,
    tier: 'rail',
    pathname: '/',
  }),
}))
// Each section has its own tests; here only what the rail makes of them.
vi.mock('../asks/NeedsYou', () => ({
  NeedsYouLauncher: () => (
    <button type="button" aria-label="Needs you: 2 questions waiting">
      2
    </button>
  ),
}))
vi.mock('./SystemSection', () => ({
  SystemSection: () => <p>system body</p>,
  useSystemState: () => ({
    worst: state.worst,
    chips: state.chips,
    pending: false,
    machines: '4 of 8 machines up',
  }),
}))
vi.mock('./ProjectsSection', () => ({
  ProjectsSection: () => <p>projects body</p>,
  useProjectTree: () => ({ tree: { groups: state.groups, quiet: [] } }),
}))
vi.mock('./QuotaMeter', () => ({
  QuotaMeter: () => (
    <button type="button" aria-label="Quota: Claude 82% left">
      82%
    </button>
  ),
}))

beforeEach(() => {
  state.open.mockClear()
  state.setTier.mockClear()
  state.worst = 'failed'
  state.chips = [{ text: '3 problems', tone: 'failed' }]
  state.groups = [{ teams: [1, 2], finished: [3] }]
})

describe('Rail', () => {
  it('has one icon per section: Needs you, System and Projects, then Quota and Settings', () => {
    render(<Rail slots={[]} onSelect={vi.fn()} onNewSession={vi.fn()} />)
    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    expect(names).toEqual([
      'New session',
      'Needs you: 2 questions waiting',
      'System: 3 problems',
      'Projects: 3 sessions in 1 project',
      'Quota: Claude 82% left',
      'Settings',
    ])
    expect(names.join('|')).not.toMatch(/Notes|Capture|Hide the side/)
  })

  it('opens System and Projects as pop-outs holding the same content as the Panel', () => {
    render(<Rail slots={[]} onSelect={vi.fn()} />)
    for (const [label, title, body] of [
      ['System: 3 problems', 'System', 'system body'],
      ['Projects: 3 sessions in 1 project', 'Projects', 'projects body'],
    ]) {
      const icon = screen.getByRole('button', { name: label })
      expect(icon).toHaveAttribute('aria-haspopup', 'dialog')
      fireEvent.click(icon)
      const dialog = screen.getByRole('dialog', { name: title })
      expect(within(dialog).getByText(body)).toBeVisible()
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
    }
  })

  it('shows the worst System state as a dot on its icon, never hiding a problem', () => {
    const { rerender } = render(<Rail slots={[]} onSelect={vi.fn()} />)
    expect(screen.getByTestId('rail-system')).toHaveAttribute(
      'data-worst',
      'failed',
    )
    state.worst = 'ok'
    state.chips = []
    rerender(<Rail slots={[]} onSelect={vi.fn()} />)
    expect(
      screen.getByRole('button', {
        name: 'System: all OK, 4 of 8 machines up',
      }),
    ).toHaveAttribute('data-worst', 'ok')
  })

  it('says plainly when no project has a session', () => {
    state.groups = []
    render(<Rail slots={[]} onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Projects' })).toBeVisible()
  })

  it('does not widen the side to show a pop-out', () => {
    render(<Rail slots={[]} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^System/ }))
    expect(state.setTier).not.toHaveBeenCalled()
    expect(state.open).not.toHaveBeenCalled()
  })

  it('ends with the Settings menu', () => {
    render(<Rail slots={[]} onSelect={vi.fn()} />)
    const settings = screen.getByRole('button', { name: 'Settings' })
    expect(settings).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(settings)
    expect(screen.getByRole('menuitem', { name: /Logins/ })).toBeVisible()
  })
})
