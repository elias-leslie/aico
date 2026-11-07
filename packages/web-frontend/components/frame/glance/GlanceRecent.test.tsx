import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlanceRecent, useRecentGlance } from './GlanceRecent'

const state = vi.hoisted(() => ({
  history: {} as Record<string, unknown>,
  live: new Map<string, unknown>(),
  tool: '',
}))
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/hooks/use-history', () => ({
  useHistory: (tool: string) => {
    state.tool = tool
    return state.history
  },
}))
vi.mock('@/lib/frame/live', () => ({
  useLiveSessions: () => ({ bySession: state.live }),
}))
vi.mock('@/lib/hooks/use-session-labels', () => ({
  useSessionLabels: () => (session: { id: string }) => `Task ${session.id}`,
}))
vi.mock('@/components/history/HistoryTranscript', () => ({
  HistoryTranscript: ({ id, embedded }: { id: string; embedded?: boolean }) => (
    <div data-testid="transcript">{`transcript ${id} ${embedded}`}</div>
  ),
}))
const widen = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../Widen', () => ({
  useWiden: (active: boolean) => {
    if (active) widen.calls += 1
  },
}))

const hour = 3_600_000
const session = (id: string, over: object = {}) => ({
  id,
  tool: 'claude-code',
  parentId: null,
  project: `Project ${id}`,
  cwd: `/srv/work/${id}`,
  model: 'opus',
  startedAt: Date.now() - 2 * hour,
  endedAt: Date.now() - 12 * 60_000,
  outcome: 'completed',
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  toolCalls: 7,
  filesWritten: 2,
  ...over,
})
const ok = (items: unknown[]) => ({
  items,
  loading: false,
  failed: false,
  stale: false,
  readAt: Date.now(),
  refetch: vi.fn(),
  refreshing: false,
})

beforeEach(() => {
  state.live = new Map()
  widen.calls = 0
  state.history = ok([])
})
afterEach(cleanup)

describe('GlanceRecent', () => {
  it('lists every session the history returns, leaving test runs behind a toggle', () => {
    state.history = ok([
      ...Array.from({ length: 9 }, (_, n) => session(`s${n + 1}`)),
      session('t', { test: true }),
    ])
    render(<GlanceRecent />)
    expect(screen.getAllByRole('listitem')).toHaveLength(9)
    expect(screen.getByText('Task s9')).toBeVisible()
    expect(screen.queryByText(/more/)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: '1 test run hidden · Show' }),
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    expect(screen.getByRole('button', { name: 'Hide test runs' })).toBeVisible()
  })

  it('shows the state chip, project, tool and age, and filters to failed ones', () => {
    state.history = ok([
      session('1'),
      session('2', { tool: 'codex', outcome: 'error' }),
    ])
    render(<GlanceRecent />)
    expect(screen.getByText('Failed')).toHaveClass('failed')
    expect(screen.getByRole('heading', { name: 'Project 2' })).toBeVisible()
    expect(screen.getByText(/Codex · 12 min ago/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Failed only' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByText('Task 1')).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Tool' }), {
      target: { value: 'pi' },
    })
    expect(state.tool).toBe('pi')
  })

  it('opens a row for its totals, switches to a running session, and reads the transcript inline in a wider side', () => {
    state.live = new Map([
      ['tether1', { session: 'tether1', conversation: '1', activity: 'idle' }],
    ])
    state.history = ok([session('1'), session('2')])
    render(<GlanceRecent />)
    const row = screen.getByText('Task 1').closest('button') as HTMLElement
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Idle')).toBeVisible()
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('/srv/work/1')).toBeVisible()
    expect(screen.getByText('opus', { exact: false })).toBeVisible()
    expect(screen.getByText(/7 tool calls · 2 files written/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open session' })).toHaveAttribute(
      'href',
      '/?session=tether1',
    )
    expect(screen.queryByTestId('transcript')).toBeNull()
    expect(widen.calls).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Show transcript' }))
    expect(screen.getByTestId('transcript')).toHaveTextContent(
      'transcript 1 true',
    )
    expect(widen.calls).toBeGreaterThan(0)
    // A session that is not running offers no Open.
    fireEvent.click(screen.getByText('Task 2').closest('button') as HTMLElement)
    expect(screen.queryByRole('link', { name: 'Open session' })).toBeNull()
  })

  it('says loading, failed (with Try again), empty and unfinished-by-filter in different words', () => {
    state.history = { items: null, loading: true, failed: false, stale: false }
    const { rerender } = render(<GlanceRecent />)
    expect(screen.getByText('Loading recent sessions…')).toBeVisible()
    state.history = {
      items: null,
      loading: false,
      failed: true,
      stale: false,
      refetch: vi.fn(),
      refreshing: false,
    }
    rerender(<GlanceRecent />)
    expect(screen.getByText('Recent sessions couldn’t be read.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
    state.history = ok([])
    rerender(<GlanceRecent />)
    expect(screen.getByText('No sessions yet.')).toBeVisible()
    state.history = ok([session('1')])
    rerender(<GlanceRecent />)
    fireEvent.click(screen.getByRole('button', { name: 'Failed only' }))
    expect(screen.getByText('No failed sessions.')).toBeVisible()
  })

  it('keeps the last list and says so when a refresh fails', () => {
    state.history = { ...ok([session('1')]), stale: true }
    render(<GlanceRecent />)
    expect(screen.getByText('Task 1')).toBeVisible()
    expect(screen.getByText(/Couldn’t refresh it/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeVisible()
  })
})

describe('GlanceRecent groups', () => {
  it('heads the day’s sessions Today and the rest Earlier, omitting an empty group', () => {
    state.history = ok([
      session('1', { endedAt: Date.now() }),
      session('2', { startedAt: 1, endedAt: 2 }),
    ])
    const { unmount } = render(<GlanceRecent />)
    expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Earlier' })).toBeVisible()
    unmount()
    state.history = ok([session('1', { endedAt: Date.now() })])
    render(<GlanceRecent />)
    expect(screen.queryByRole('heading', { name: 'Earlier' })).toBeNull()
  })
})

describe('Recent by project', () => {
  it('lists today’s sessions under their project, newest project first, and leaves earlier days flat', () => {
    state.history = ok([
      session('1', { endedAt: Date.now() - 5000, project: 'Alpha' }),
      session('2', { endedAt: Date.now(), project: 'Beta' }),
      session('3', { endedAt: Date.now() - 9000, project: 'Alpha' }),
      session('old', { startedAt: 1, endedAt: 2, project: 'Gamma' }),
    ])
    render(<GlanceRecent />)
    expect(
      screen
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual(['Beta', 'Alpha'])
    expect(screen.queryByText('Today: 3 sessions')).toBeNull()
    expect(screen.queryByText('See the day')).toBeNull()
  })
})

describe('useRecentGlance', () => {
  const Line = () => <p>{useRecentGlance().value}</p>
  it('counts today’s sessions, leaving test runs and earlier days out', () => {
    state.history = ok([
      session('1', { endedAt: Date.now() }),
      session('2', { endedAt: Date.now() }),
      session('t', { endedAt: Date.now(), test: true }),
      session('old', { startedAt: 1, endedAt: 2 }),
    ])
    render(<Line />)
    expect(screen.getByText('2 today')).toBeVisible()
  })
  it('names the last session’s time when none ran today, and says none yet', () => {
    state.history = ok([
      session('old', { startedAt: 1, endedAt: Date.now() - 3 * 86_400_000 }),
    ])
    const { rerender } = render(<Line />)
    expect(screen.getByText(/^last /)).toBeVisible()
    state.history = ok([])
    rerender(<Line />)
    expect(screen.getByText('none yet')).toBeVisible()
  })
  it('says why there is nothing to count', () => {
    state.history = { items: null, loading: true, failed: false, stale: false }
    const { rerender } = render(<Line />)
    expect(screen.getByText('Checking…')).toBeVisible()
    state.history = { items: null, loading: false, failed: true, stale: false }
    rerender(<Line />)
    expect(screen.getByText('Couldn’t read')).toBeVisible()
  })
})
