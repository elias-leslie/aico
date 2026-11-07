import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Panel } from './Panel'

const state = vi.hoisted(() => ({
  open: vi.fn(),
  phone: false,
  tier: 'panel',
  notes: vi.fn((..._args: unknown[]) => true),
  status: { value: '3 problems', tone: 'failed' as string | null, problems: 3 },
}))
vi.mock('./FrameContext', () => ({
  useFrame: () => ({
    open: state.open,
    docked: !state.phone,
    tier: state.tier,
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

// Each glance has its own tests; here only what the Panel does with them.
vi.mock('./glance/GlanceStatus', () => ({
  useStatusGlance: () => state.status,
  GlanceStatus: () => <p>status body</p>,
}))
vi.mock('./glance/GlanceQuota', () => ({
  useQuotaGlance: () => ({ value: 'Claude 82% left', tone: null }),
  GlanceQuota: () => <p>quota body</p>,
}))
vi.mock('./glance/GlanceBackups', () => ({
  useBackupsGlance: () => ({ value: 'all fresh', tone: 'ok' }),
  GlanceBackups: () => <p>backups body</p>,
}))
vi.mock('./glance/GlanceRecent', () => ({
  useRecentGlance: () => ({ value: '1 today', tone: null }),
  GlanceRecent: () => <p>recent body</p>,
}))
vi.mock('./glance/GlanceMachines', () => ({
  useMachinesGlance: () => ({ value: '2 of 3 on', tone: null }),
  GlanceMachines: () => <p>machines body</p>,
}))
vi.mock('./glance/GlanceProjects', () => ({
  useProjectsGlance: () => ({ value: '4 active', tone: null }),
  GlanceProjects: () => <p>projects body</p>,
}))
vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => ({ forSlot: () => null, needsYouCount: 0 }),
}))
vi.mock('../asks/NeedsYou', () => ({
  NeedsYouSection: () => <section aria-label="Needs you" />,
}))
vi.mock('../SessionList', () => ({ SessionList: () => <p>rows</p> }))
vi.mock('../capture/CaptureLauncher', () => ({ CaptureLauncher: () => null }))
vi.mock('@/lib/notes-window', () => ({
  openNotes: (...args: unknown[]) => state.notes(...args),
}))

const slots = [] as never[]

const FOLDS_KEY = 'aico-panel-folds'
const expanded = (name: string) =>
  screen
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .getAttribute('aria-expanded')
const sections = [
  'Status',
  'Quota',
  'Backups',
  'Recent',
  'Machines',
  'Projects',
]

describe('Panel', () => {
  beforeEach(() => {
    localStorage.clear()
    state.phone = false
    state.tier = 'panel'
    state.status = { value: '3 problems', tone: 'failed', problems: 3 }
    state.notes.mockClear()
    state.open.mockClear()
  })

  it('goes straight to Needs you and the sessions, then the glance sections', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Status3 problems',
      'QuotaClaude 82% left',
      'Backupsall fresh',
      'Recent1 today',
      'Machines2 of 3 on',
      'Projects4 active',
    ])
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeVisible()
  })

  it('opens Status, Quota, Backups and Recent and folds Machines and Projects', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    for (const name of ['Status', 'Quota', 'Backups', 'Recent'])
      expect(expanded(name)).toBe('true')
    for (const name of ['Machines', 'Projects'])
      expect(expanded(name)).toBe('false')
    expect(screen.getByText('status body')).toBeVisible()
    expect(screen.queryByText('machines body')).toBeNull()
  })

  it('remembers a fold on this device and works when storage is unavailable', () => {
    const { unmount } = render(<Panel slots={slots} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Quota/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Projects/ }))
    expect(JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}')).toEqual({
      Quota: false,
      Projects: true,
    })
    unmount()
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(expanded('Quota')).toBe('false')
    expect(expanded('Projects')).toBe('true')
    expect(expanded('Status')).toBe('true')
  })

  it('still folds and opens when localStorage throws', () => {
    const read = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Machines/ }))
    expect(expanded('Machines')).toBe('true')
    read.mockRestore()
    write.mockRestore()
  })

  it('on a phone folds Quota, Backups and Recent to a line and keeps Status open while it has problems', () => {
    state.phone = true
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(expanded('Status')).toBe('true')
    for (const name of ['Quota', 'Backups', 'Recent'])
      expect(expanded(name)).toBe('false')
    expect(screen.getByText('Claude 82% left')).toBeVisible()
  })

  it('on a phone folds Status too once it has no problems', () => {
    state.phone = true
    state.status = { value: 'all healthy', tone: 'ok', problems: 0 }
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(expanded('Status')).toBe('false')
    expect(screen.getByText('all healthy')).toBeVisible()
  })

  it('has one even row per section: a value on the same line, no Open link, no Today line', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.queryByRole('link', { name: /^Open/ })).toBeNull()
    expect(screen.queryByText(/^Today/)).toBeNull()
    expect(screen.queryByText('See the day')).toBeNull()
    for (const name of sections) {
      const heading = screen.getByRole('heading', {
        name: new RegExp(`^${name}`),
      })
      expect(within(heading).getAllByRole('button')).toHaveLength(1)
    }
  })

  it('has no Everything else grid: the setup places live under Settings, and nothing else is listed twice', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.queryByRole('region', { name: 'Everything else' })).toBeNull()
    for (const gone of ['Grants', 'Recovery', 'Logins', 'Context', 'Phone app'])
      expect(screen.queryByRole('link', { name: gone })).toBeNull()
  })

  it('pins Notes, Capture and Settings in a footer, Notes opening in its own window', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    // With no argument, openNotes takes the project of the session on screen.
    expect(state.notes).toHaveBeenCalledWith()
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
