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
  asks: { asks: [{ id: 'a' }, { id: 'b' }], isLoading: false, isError: false },
  open: vi.fn(),
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
vi.mock('@/lib/hooks/use-usage', () => ({ useUsage: () => state.usage }))
vi.mock('@/lib/hooks/use-asks', () => ({
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
    asks: [{ id: 'a' }, { id: 'b' }],
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
  it('leads with what happened since the last look, then the sections in order', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    const since = screen.getByTestId('since-line')
    expect(since).toHaveTextContent(
      /Since .*3 finished, 1 of them failed, 1 quiet \(stuck\), 2 questions waiting/,
    )
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Sessions', 'Worst problem', 'Quota', 'Everything else'])
    // "1 of them failed" opens the failed sessions.
    expect(
      screen.getByRole('link', { name: '1 of them failed' }),
    ).toHaveAttribute('href', '/history?standing=failed')
    fireEvent.click(screen.getByRole('link', { name: 'See the day' }))
    expect(state.open).toHaveBeenCalledWith('/today', 'wide')
  })

  it('says how far back it counts when this device never looked, not a time it never had', () => {
    state.lastLook = null
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    const since = screen.getByTestId('since-line')
    expect(since).toHaveTextContent(/^Past 12 hours/)
    expect(since).not.toHaveTextContent(/Since/)
  })

  it('lists every place to open, Quota and Recovery included, at their own addresses', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    const places = screen.getByRole('region', { name: 'Everything else' })
    const href = (name: RegExp | string) =>
      within(places).getByRole('link', { name }).getAttribute('href')
    expect(href('Quota')).toBe('/quota')
    expect(href('Recovery')).toBe('/recovery')
    expect(href('Machines')).toBe('/machines')
    fireEvent.click(within(places).getByRole('link', { name: 'Quota' }))
    expect(state.open).toHaveBeenCalledWith('/quota', 'wide')
  })

  it('names the worst problem and opens Status', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.getByText('Restore drill')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Open Status' }))
    expect(state.open).toHaveBeenCalledWith('/status', 'wide')
  })

  it('shows a quota bar with what is used, and glance values only where read', () => {
    render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(
      screen.getByRole('img', {
        name: 'Claude: 82% left, 60% of the window gone',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('link', { name: /Status.*3 problems/ }),
    ).toBeVisible()
    expect(
      screen.getByRole('link', { name: /Grants.*1 waiting/ }),
    ).toBeVisible()
    // Nothing is read for Backups here, so no value is made up.
    expect(screen.getByRole('link', { name: 'Backups' })).toBeVisible()
  })

  it('has its own copy for loading, failed and quiet states, never a zero for unknown', () => {
    state.digest = { ...state.digest, digest: null, loading: true }
    state.status = { view: null, loading: true, failed: false, stale: false }
    state.usage = { ...state.usage, report: null, loading: true }
    const { rerender } = render(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.getByText('Checking what happened…')).toBeVisible()
    expect(screen.getByText('Checking Status…')).toBeVisible()

    state.digest = { ...state.digest, loading: false, failed: true }
    state.status = { view: null, loading: false, failed: true, stale: false }
    state.usage = { ...state.usage, loading: false, failed: true }
    rerender(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.getByText(/Couldn’t read what happened/)).toBeVisible()
    expect(screen.getByText('Status couldn’t be read.')).toBeVisible()
    expect(screen.getByText('Quota couldn’t be read.')).toBeVisible()
    expect(screen.queryByText('No problems.')).toBeNull()

    state.digest = {
      ...state.digest,
      failed: false,
      digest: digest({ unavailable: ['history'] }),
    }
    rerender(<Panel slots={slots} onSelect={vi.fn()} />)
    expect(screen.getByText(/finished sessions not read/)).toBeVisible()
    expect(screen.queryByText(/nothing finished/)).toBeNull()
  })
})
