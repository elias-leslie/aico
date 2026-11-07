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
  useFrame: () => ({ open: state.open }),
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
vi.mock('@/lib/notes-window', () => ({ popOutNotes: () => true }))

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
  })

  it('goes straight to Needs you and the sessions, then the glance sections and the places for setup', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.queryByTestId('since-line')).toBeNull()
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Status',
      'Quota',
      'Backups',
      'Recent',
      'Machines',
      'Projects',
      'Everything else',
    ])
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

  it('keeps only the setup places in Everything else, with no Notes entry (the top bar opens Notes)', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    const places = screen.getByRole('region', { name: 'Everything else' })
    const href = (name: RegExp | string) =>
      within(places).getByRole('link', { name }).getAttribute('href')
    expect(href('Recovery')).toBe('/recovery')
    expect(href('Logins')).toBe('/logins')
    fireEvent.click(within(places).getByRole('link', { name: 'Recovery' }))
    expect(state.open).toHaveBeenCalledWith('/recovery', 'full')
    for (const gone of [
      'Status',
      'Projects',
      'Recent',
      'Quota',
      'Backups',
      'Machines',
    ])
      expect(within(places).queryByRole('link', { name: gone })).toBeNull()
    expect(within(places).queryByText('Notes')).toBeNull()
  })

  it('shows a waiting-grants value only where it is read', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(
      screen.getByRole('link', { name: /Grants.*1 waiting/ }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Logins' })).toBeVisible()
  })
})
