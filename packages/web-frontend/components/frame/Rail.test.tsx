import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Rail } from './Rail'

const state = vi.hoisted(() => ({
  open: vi.fn(),
  setTier: vi.fn(),
  problems: 9 as number | null,
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
vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => ({ forSlot: () => null, needsYouCount: 0 }),
}))
vi.mock('@/lib/hooks/use-usage', () => ({ useUsage: () => ({ report: null }) }))
vi.mock('../SessionList', () => ({
  SessionRail: () => null,
  sessionsHeading: () => 'Sessions · 0',
}))
vi.mock('../asks/NeedsYou', () => ({ NeedsYouLauncher: () => null }))
vi.mock('../capture/CaptureLauncher', () => ({
  CaptureLauncher: () => <button type="button">Capture</button>,
}))
vi.mock('./glance/GlanceStatus', () => ({
  useStatusGlance: () => ({
    problems: state.problems,
    count: '9 problems',
    line: null,
  }),
  GlanceStatus: () => <p>status body</p>,
}))
vi.mock('./glance/GlanceQuota', () => ({
  useQuotaGlance: () => ({ count: null, line: null }),
  GlanceQuota: () => <p>quota body</p>,
}))
vi.mock('./glance/GlanceBackups', () => ({
  useBackupsGlance: () => ({ count: null, line: null }),
  GlanceBackups: () => <p>backups body</p>,
}))
vi.mock('./glance/GlanceMachines', () => ({
  useMachinesGlance: () => ({ count: '4 up, 4 off', line: null }),
  GlanceMachines: () => <p>machines body</p>,
}))
vi.mock('./glance/GlanceProjects', () => ({
  useProjectsGlance: () => ({ count: null, line: null }),
  GlanceProjects: () => <p>projects body</p>,
}))
vi.mock('./glance/GlanceRecent', () => ({
  useRecentGlance: () => ({ count: null, line: null }),
  GlanceRecent: () => <p>recent body</p>,
}))

beforeEach(() => {
  state.open.mockClear()
  state.setTier.mockClear()
  state.problems = 9
})

describe('Rail', () => {
  it('opens each data icon as a pop-out holding that glance, with no Open link', () => {
    render(<Rail slots={[]} onSelect={vi.fn()} />)
    const cases: [string, string, string][] = [
      ['Status: 9 problems', 'Status', 'status body'],
      ['Quota', 'Quota', 'quota body'],
      ['Projects', 'Projects', 'projects body'],
      ['Backups', 'Backups', 'backups body'],
      ['Machines', 'Machines', 'machines body'],
      ['Recent', 'Recent', 'recent body'],
    ]
    for (const [label, title, body] of cases) {
      const icon = screen.getByRole('button', { name: label })
      expect(icon).toHaveAttribute('aria-haspopup', 'dialog')
      fireEvent.click(icon)
      const dialog = screen.getByRole('dialog', { name: title })
      expect(within(dialog).getByText(body)).toBeVisible()
      expect(within(dialog).queryByRole('link')).toBeNull()
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
    }
  })

  it('keeps the Status problem count on its icon', () => {
    render(<Rail slots={[]} onSelect={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: 'Status: 9 problems' }),
    ).toHaveTextContent('9')
  })

  it('does not widen the side to show a pop-out', () => {
    render(<Rail slots={[]} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quota' }))
    expect(state.setTier).not.toHaveBeenCalled()
    expect(state.open).not.toHaveBeenCalled()
  })

  it('ends with Notes, Capture and the Settings menu, with no hide or panel button of its own', () => {
    render(<Rail slots={[]} onSelect={vi.fn()} />)
    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    expect(names.slice(-3)).toEqual([
      'Notes: opens in its own window',
      'Capture',
      'Settings',
    ])
    expect(names.join('|')).not.toMatch(/Hide the side|Open the panel/)
    const settings = screen.getByRole('button', { name: 'Settings' })
    expect(settings).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(settings)
    expect(screen.getByRole('menuitem', { name: /Logins/ })).toBeVisible()
  })
})
