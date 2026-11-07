import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Panel } from './Panel'

const state = vi.hoisted(() => ({
  digest: {
    digest: null as unknown,
    loading: false,
    failed: false,
    stale: false,
    refetch: vi.fn(),
  },
  status: {
    view: null as unknown,
    loading: false,
    failed: false,
    stale: false,
  },
  usage: {
    report: null as unknown,
    loading: false,
    failed: false,
    stale: false,
  },
  asks: {
    asks: [
      { id: 'a', state: 'open' },
      { id: 'b', state: 'open' },
    ],
    isLoading: false,
    isError: false,
  },
  open: vi.fn(),
  phone: false,
  docked: true,
  notes: vi.fn((_path: string) => true),
  backups: {
    entries: [] as unknown[] | null,
    loading: false,
    failed: false,
    stale: false,
  },
  history: {
    items: [] as unknown[] | null,
    loading: false,
    failed: false,
    stale: false,
  },
  projects: {
    data: [] as unknown[] | undefined,
    isPending: false,
    isError: false,
  },
  push: vi.fn(),
  sessions: {
    names: new Map([['fa41c0c8', 'Aico']]) as ReadonlyMap<
      string,
      string
    > | null,
    resumable: new Set<string>(),
  },
  lastLook: null as number | null,
}))
vi.mock('./FrameContext', () => ({
  useFrame: () => ({ open: state.open, docked: state.docked }),
}))
vi.mock('@/lib/frame/digest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/frame/digest')>()),
  useLastLook: () => state.lastLook,
  useDigest: () => state.digest,
}))
vi.mock('@/lib/hooks/use-status', () => ({ useStatus: () => state.status }))
vi.mock('@tanstack/react-query', async (real) => ({
  ...(await real<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('@/lib/hooks/use-hosts', () => ({
  useHosts: () => ({ hosts: [], isLoading: false, isError: false }),
}))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => state.phone,
}))
vi.mock('@/lib/hooks/use-backups', () => ({ useBackups: () => state.backups }))
vi.mock('@/lib/hooks/use-history', () => ({ useHistory: () => state.history }))
vi.mock('@/lib/frame/live', () => ({
  useLiveSessions: () => ({ bySession: new Map() }),
}))
vi.mock('@/lib/hooks/use-projects', () => ({
  useProjectOverview: () => state.projects,
}))
vi.mock('@/lib/hooks/use-status-sessions', () => ({
  RECOVERY_QUERY_KEY: ['status-recovery'],
  useStatusSessions: () => state.sessions,
}))
vi.mock('@/lib/hooks/use-usage', () => ({ useUsage: () => state.usage }))
vi.mock('@/lib/hooks/use-asks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/use-asks')>()),
  useOwnerAsks: () => state.asks,
  openAsks: (asks: unknown[]) => asks,
  useApprovals: () => ({ approvals: { state: 'ok', taps: [{ id: 't' }] } }),
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
  popOutNotes: (path: string) => state.notes(path),
}))

const digest = (patch: object = {}) => ({
  since: 0,
  generatedAt: 0,
  finished: 3,
  failed: 1,
  stuck: { quiet: 1, waiting: 0 },
  asks: 2,
  problems: { count: 0, failed: 0 },
  spend: null,
  unavailable: [],
  ...patch,
})
const row = (patch: object = {}) => ({
  id: 'job/restore',
  what: 'Restore drill',
  machine: 'Workstation',
  meaning: 'It was stopped for memory.',
  state: 'failed',
  shown: 'failed',
  ...patch,
})

beforeEach(() => {
  state.digest = {
    digest: digest(),
    loading: false,
    failed: false,
    stale: false,
    refetch: vi.fn(),
  }
  state.usage = {
    report: {
      as_of: '',
      collected_at: '',
      providers: [
        {
          id: 'claude',
          name: 'Claude',
          status: 'ok',
          summary: null,
          plan: null,
          windows: [
            {
              label: 'weekly',
              state: 'ok',
              left_percent: 82,
              resets_at: null,
              length_seconds: 1000,
              resets_in_seconds: 400,
              text: 'weekly 82% left',
            },
          ],
          credits: null,
          problem: null,
          spend: { unit: null, recorded_since: null, days: [] },
        },
      ],
    },
    loading: false,
    failed: false,
    stale: false,
  }
  state.asks = {
    asks: [
      { id: 'a', state: 'open' },
      { id: 'b', state: 'open' },
    ],
    isLoading: false,
    isError: false,
  }
  state.status = {
    view: {
      summary: { problems: 3, top: [row()] },
      rows: [],
    },
    loading: false,
    failed: false,
    stale: false,
  }
  state.open.mockClear()
  state.lastLook = Date.now() - 3_600_000
})

const slots = [] as never[]

const FOLDS_KEY = 'aico-panel-folds'
const expanded = (name: string) =>
  screen.getByRole('button', { name }).getAttribute('aria-expanded')

describe('Panel', () => {
  beforeEach(() => {
    localStorage.clear()
    state.phone = false
    state.docked = true
    state.notes.mockClear()
  })

  it('goes straight to Needs you and the sessions, then the glance sections', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.queryByTestId('since-line')).toBeNull()
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Status', 'Quota', 'Backups', 'Recent', 'Machines', 'Projects'])
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeVisible()
  })

  it('opens Status, Quota, Backups and Recent and folds Machines and Projects', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    for (const name of ['Status', 'Quota', 'Backups', 'Recent'])
      expect(expanded(name)).toBe('true')
    for (const name of ['Machines', 'Projects'])
      expect(expanded(name)).toBe('false')
    expect(screen.getByText('3 problems')).toBeVisible()
  })

  it('remembers a fold on this device and works when storage is unavailable', () => {
    const { unmount } = render(<Panel slots={slots} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quota' }))
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Machines' }))
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
    state.status = {
      view: { summary: { problems: 0, top: [] }, rows: [] },
      loading: false,
      failed: false,
      stale: false,
    }
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(expanded('Status')).toBe('false')
    expect(screen.getByText('all healthy')).toBeVisible()
  })

  it('opens each section’s page in place: Wide for the daily ones, Full for Backups and Machines', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('link', { name: 'Open Quota' }))
    expect(state.open).toHaveBeenLastCalledWith('/quota', 'wide')
    fireEvent.click(screen.getByRole('link', { name: 'Open Backups' }))
    expect(state.open).toHaveBeenLastCalledWith('/backups', 'full')
    fireEvent.click(screen.getByRole('link', { name: 'Open Machines' }))
    expect(state.open).toHaveBeenLastCalledWith('/machines', 'full')
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
    expect(state.notes).toHaveBeenCalledWith('/notes')
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
    expect(state.open).toHaveBeenCalledWith('/recovery', 'full')
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
    state.docked = false
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
    expect(state.open).toHaveBeenLastCalledWith('/grants', 'full')
  })
})
