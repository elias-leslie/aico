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
vi.mock('@/lib/hooks/use-hosts', () => ({ useHosts: () => ({ hosts: [] }) }))
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

describe('Panel', () => {
  it('goes straight to Needs you and the sessions: no since card, no Sessions heading over the state groups', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.queryByTestId('since-line')).toBeNull()
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Everything else'])
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeVisible()
  })

  it('lists every place to open, Quota and Recovery included, at their own addresses, and no Notes entry (the top bar opens Notes)', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    const places = screen.getByRole('region', { name: 'Everything else' })
    const href = (name: RegExp | string) =>
      within(places).getByRole('link', { name }).getAttribute('href')
    expect(href('Quota')).toBe('/quota')
    expect(href('Recovery')).toBe('/recovery')
    expect(href('Machines')).toBe('/machines')
    fireEvent.click(within(places).getByRole('link', { name: 'Quota' }))
    expect(state.open).toHaveBeenCalledWith('/quota', 'wide')
    expect(within(places).queryByText('Notes')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Worst problem' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Quota' })).toBeNull()
  })

  it('shows glance values only where read', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(
      screen.getByRole('link', { name: /Status.*3 problems/ }),
    ).toBeVisible()
    expect(
      screen.getByRole('link', { name: /Grants.*1 waiting/ }),
    ).toBeVisible()
    // Nothing is read for Backups here, so no value is made up.
    expect(screen.getByRole('link', { name: 'Backups' })).toBeVisible()
  })

  it('shows no Status count while Status is unread, never a zero for unknown', () => {
    state.status = { view: null, loading: true, failed: false, stale: false }
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'Status' })).toBeVisible()
  })
})
