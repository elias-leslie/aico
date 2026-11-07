import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Disclosure } from './Disclosure'
import { GlanceBackups, useBackupsGlance } from './GlanceBackups'
import { GlanceMachines, useMachinesGlance } from './GlanceMachines'
import { GlanceProjects } from './GlanceProjects'
import { GlanceQuota, useQuotaGlance } from './GlanceQuota'
import { GlanceRecent, useRecentGlance } from './GlanceRecent'
import { GlanceStatus, useStatusGlance } from './GlanceStatus'

const state = vi.hoisted(() => ({
  open: vi.fn(),
  status: {} as Record<string, unknown>,
  usage: {} as Record<string, unknown>,
  backups: {} as Record<string, unknown>,
  history: {} as Record<string, unknown>,
  projects: {} as Record<string, unknown>,
  hosts: {} as Record<string, unknown>,
}))
vi.mock('../FrameContext', () => ({ useFrame: () => ({ open: state.open }) }))
vi.mock('@/lib/hooks/use-status', () => ({ useStatus: () => state.status }))
vi.mock('@/lib/hooks/use-status-sessions', () => ({
  useStatusSessions: () => ({ names: new Map([['abc', 'Aico']]) }),
}))
vi.mock('@/lib/hooks/use-usage', () => ({ useUsage: () => state.usage }))
vi.mock('@/lib/hooks/use-backups', () => ({ useBackups: () => state.backups }))
vi.mock('@/lib/hooks/use-history', () => ({ useHistory: () => state.history }))
vi.mock('@/lib/frame/live', () => ({
  useLiveSessions: () => ({ bySession: new Map() }),
}))
vi.mock('@/lib/hooks/use-projects', () => ({
  useProjectOverview: () => state.projects,
}))
vi.mock('@/lib/hooks/use-hosts', () => ({ useHosts: () => state.hosts }))

const row = (id: string, shown: string, what: string) => ({
  id,
  what,
  kind: 'job',
  machine: 'davion-sidarli',
  state: 'failed',
  shown,
  shown_since: null,
  updated_at: new Date().toISOString(),
  meaning: `${what} meaning abc`,
})
const hour = 3_600_000
const entry = (
  target: string,
  ageH: number,
  limitHours: number,
  name = 'Src',
) => ({
  id: `${target}/${name}`,
  source: name,
  name,
  target,
  dataAt: new Date(Date.now() - ageH * hour).toISOString(),
  nextRun: null,
  state: 'ok',
  meaning: '',
  snapshot: null,
  path: null,
  machine: 'x',
  limitHours,
})
const session = (id: string, over: object = {}) => ({
  id,
  tool: 'claude-code',
  parentId: null,
  project: `Project ${id}`,
  cwd: null,
  model: null,
  startedAt: Date.now() - 2 * hour,
  endedAt: Date.now() - 12 * 60_000,
  outcome: 'completed',
  tokens: { input: 0, cacheRead: 0, output: 0 },
  toolCalls: 0,
  filesWritten: 0,
  ...over,
})
const project = (id: string, over: object = {}) => ({
  id,
  name: id,
  archived: false,
  top: null,
  waiting: null,
  runState: null,
  problems: [],
  agents: 0,
  lastActivity: null,
  ...over,
})

beforeEach(() => {
  state.open.mockClear()
  state.status = {
    view: {
      summary: {
        problems: 5,
        top: [
          row('a', 'failed', 'Nightly publication'),
          row('b', 'warn', 'Vault archive'),
          row('c', 'unknown', 'Detection health'),
          row('d', 'late', 'Fourth'),
        ],
      },
      rows: [],
    },
    loading: false,
    failed: false,
    stale: false,
  }
  state.usage = { report: null, loading: false, failed: false, stale: false }
  state.backups = { entries: [], loading: false, failed: false, stale: false }
  state.history = {
    items: [],
    loading: false,
    failed: false,
    stale: false,
  }
  state.projects = { data: [], isPending: false, isError: false }
  state.hosts = { hosts: [], isLoading: false, isError: false }
})

describe('GlanceStatus', () => {
  it('lists the top three with state chips and links to the rest', () => {
    render(<GlanceStatus />)
    expect(screen.getByText('Failed')).toHaveClass('failed')
    expect(screen.getByText('Warning')).toBeVisible()
    expect(screen.getByText('Unknown')).toBeVisible()
    expect(screen.queryByText('Fourth')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: '2 more in Status' }))
    expect(state.open).toHaveBeenCalledWith('/status', 'wide')
  })

  it('says what it is doing while unread, when it failed and when all is well', () => {
    state.status = { view: null, loading: true, failed: false, stale: false }
    const { rerender } = render(<GlanceStatus />)
    expect(screen.getByText('Checking Status…')).toBeVisible()
    state.status = { view: null, loading: false, failed: true, stale: false }
    rerender(<GlanceStatus />)
    expect(screen.getByText('Status couldn’t be read.')).toBeVisible()
    state.status = {
      view: { summary: { problems: 0, top: [] }, rows: [] },
      loading: false,
      failed: false,
      stale: false,
    }
    rerender(<GlanceStatus />)
    expect(screen.getByText('Nothing needs attention.')).toBeVisible()
  })

  it('gives the heading a count, never a zero for unread', () => {
    const Head = () => <p>{useStatusGlance().count ?? 'none'}</p>
    const { rerender } = render(<Head />)
    expect(screen.getByText('5 problems')).toBeVisible()
    state.status = { view: null, loading: true, failed: false, stale: false }
    rerender(<Head />)
    expect(screen.getByText('none')).toBeVisible()
  })
})

const provider = (id: string, name: string, over: object = {}) => ({
  id,
  name,
  status: 'ok',
  answer: 'Available',
  plan: null,
  windows: [
    {
      label: 'weekly',
      state: 'ok',
      left_percent: 73,
      resets_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      length_seconds: 1000,
      resets_in_seconds: 400,
      text: 'weekly 73% left',
    },
  ],
  credits: null,
  problem: null,
  spend: { unit: null, recorded_since: null, days: [] },
  ...over,
})

describe('GlanceQuota', () => {
  it('shows one bar per provider with its short line', () => {
    state.usage = {
      report: {
        as_of: '',
        collected_at: '',
        providers: [provider('claude', 'Claude')],
      },
      loading: false,
      failed: false,
      stale: false,
    }
    const Both = () => (
      <>
        <GlanceQuota />
        <p>{useQuotaGlance().line}</p>
      </>
    )
    render(<Both />)
    expect(screen.getByRole('img', { name: /Claude: 73% left/ })).toBeVisible()
    expect(screen.getAllByText(/^73% left · resets/)).toHaveLength(1)
    expect(screen.getByText('Claude 73% left')).toBeVisible()
  })

  it('has its own copy for loading, failed and empty', () => {
    state.usage = { report: null, loading: true, failed: false, stale: false }
    const { rerender } = render(<GlanceQuota />)
    expect(screen.getByText('Checking quota…')).toBeVisible()
    state.usage = { report: null, loading: false, failed: true, stale: false }
    rerender(<GlanceQuota />)
    expect(screen.getByText('Quota couldn’t be read.')).toBeVisible()
    state.usage = { report: null, loading: false, failed: false, stale: false }
    rerender(<GlanceQuota />)
    expect(screen.getByText('No quota reports yet.')).toBeVisible()
  })
})

describe('GlanceBackups', () => {
  beforeEach(() => {
    state.backups = {
      entries: [
        entry('drive', 38, 36, 'Vault'),
        entry('native', 0.25, 8),
        entry('append', 1, 2),
      ],
      loading: false,
      failed: false,
      stale: false,
    }
  })

  it('shows the oldest copy per destination against its limit, the late one in ember', () => {
    const { container } = render(<GlanceBackups />)
    expect(screen.getByText('38 h old, late after 36 h')).toBeVisible()
    expect(screen.getByText('15 min old, late after 8 h')).toBeVisible()
    expect(screen.getByText('T7')).toBeVisible()
    expect(container.querySelectorAll('li[data-late="true"]')).toHaveLength(1)
  })

  it('folds to the most overdue destination and how the rest stand', () => {
    const Line = () => <p>{useBackupsGlance().line}</p>
    render(<Line />)
    expect(
      screen.getByText('Drive 38 h old, late after 36 h · 2 more fine'),
    ).toBeVisible()
  })

  it('says unread, failed, empty and undated in different words', () => {
    state.backups = {
      entries: null,
      loading: true,
      failed: false,
      stale: false,
    }
    const { rerender } = render(<GlanceBackups />)
    expect(screen.getByText('Checking backups…')).toBeVisible()
    state.backups = {
      entries: null,
      loading: false,
      failed: true,
      stale: false,
    }
    rerender(<GlanceBackups />)
    expect(screen.getByText('Backups couldn’t be read.')).toBeVisible()
    state.backups = { entries: [], loading: false, failed: false, stale: false }
    rerender(<GlanceBackups />)
    expect(screen.getByText('No backups are registered yet.')).toBeVisible()
    state.backups = {
      entries: [{ ...entry('drive', 1, 6), dataAt: null }],
      loading: false,
      failed: false,
      stale: false,
    }
    rerender(<GlanceBackups />)
    expect(screen.getByText('No copy has an age to show yet.')).toBeVisible()
  })
})

describe('GlanceRecent', () => {
  it('lists the last four with state chip, agent and age, leaving out test runs', () => {
    state.history = {
      items: [
        session('1'),
        session('2', { tool: 'codex', outcome: 'error' }),
        session('t', { test: true }),
        session('3'),
        session('4'),
        session('5'),
      ],
      loading: false,
      failed: false,
      stale: false,
    }
    render(<GlanceRecent />)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText('Failed')).toHaveClass('failed')
    expect(screen.getByText(/Codex · 12 min ago/)).toBeVisible()
    expect(screen.queryByText('Project 5')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'Project 1' }))
    expect(state.open).toHaveBeenCalledWith('/history?session=1', 'wide')
  })

  it('folds to the first two and a count; says why when unread', () => {
    state.history = {
      items: [session('1'), session('2'), session('3')],
      loading: false,
      failed: false,
      stale: false,
    }
    const Line = () => <p>{useRecentGlance().line}</p>
    const { rerender } = render(<Line />)
    expect(
      screen.getByText('Project 1 12 min ago · Project 2 12 min ago · 1 more'),
    ).toBeVisible()
    state.history = { items: null, loading: false, failed: true, stale: false }
    rerender(<Line />)
    expect(screen.getByText('Recent sessions couldn’t be read.')).toBeVisible()
  })
})

describe('GlanceProjects', () => {
  beforeEach(() => {
    state.projects = {
      data: [
        project('Aico', {
          top: 'Ship it',
          problems: [{ kind: 'publish', count: 1 }],
          agents: 1,
        }),
        project('Quiet One'),
        project('Quiet Two'),
      ],
      isPending: false,
      isError: false,
    }
  })

  it('gives a project its key line and chips, and the quiet ones one line', () => {
    render(<GlanceProjects />)
    expect(screen.getByText(/Now: Ship it/)).toBeVisible()
    expect(screen.getByText('1 publish')).toHaveClass('failed')
    expect(screen.getByText('1 working')).toHaveClass('running')
    expect(screen.getByText('Quiet: Quiet One, Quiet Two')).toBeVisible()
  })

  it('finds a project and says when none matches', () => {
    render(<GlanceProjects />)
    const find = screen.getByRole('searchbox', { name: 'Find a project' })
    fireEvent.change(find, { target: { value: 'two' } })
    expect(screen.getByText('Quiet Two')).toBeVisible()
    expect(screen.queryByText('Aico')).toBeNull()
    fireEvent.change(find, { target: { value: 'zzz' } })
    expect(screen.getByText('No project matches.')).toBeVisible()
  })

  it('says loading and failed in different words', () => {
    state.projects = { data: undefined, isPending: true, isError: false }
    const { rerender } = render(<GlanceProjects />)
    expect(screen.getByText('Loading projects…')).toBeVisible()
    state.projects = { data: undefined, isPending: false, isError: true }
    rerender(<GlanceProjects />)
    expect(screen.getByText('Projects couldn’t be read.')).toBeVisible()
  })
})

describe('GlanceMachines', () => {
  const machineRow = (machine: string, shown: string) => ({
    ...row(`m/${machine}`, shown, machine),
    kind: 'machine',
    machine,
  })
  beforeEach(() => {
    state.status = {
      view: {
        machine: 'davion-sidarli',
        summary: { problems: 0, top: [] },
        rows: [machineRow('davion-gem', 'ok'), machineRow('jobinator', 'off')],
      },
      loading: false,
      failed: false,
      stale: false,
    }
  })

  it('names each machine with an up or off chip, up ones first', () => {
    render(<GlanceMachines />)
    const chips = screen.getAllByRole('listitem')
    expect(chips.length).toBeGreaterThanOrEqual(3)
    expect(
      within(chips[0] as HTMLElement).getByText(/is on/),
    ).toBeInTheDocument()
    const off = chips.find((chip) => chip.textContent?.includes('jobinator'))
    expect(off).toHaveClass('off')
  })

  it('counts up and off for the heading, and says why when Status is unread', () => {
    const Head = () => {
      const head = useMachinesGlance()
      return <p>{head.count ?? head.line}</p>
    }
    const { rerender } = render(<Head />)
    expect(screen.getByText('2 up, 1 off')).toBeVisible()
    state.status = { view: null, loading: false, failed: true, stale: false }
    rerender(<Head />)
    expect(
      screen.getByText(
        'Machines couldn’t be read; only the session hosts are known.',
      ),
    ).toBeVisible()
  })
})

describe('Disclosure', () => {
  it('folds to its summary line and says whether it is open', () => {
    const toggle = vi.fn()
    const { rerender } = render(
      <Disclosure
        title="Quota"
        head={{ count: null, line: 'Claude 73% left' }}
        href="/quota"
        where="wide"
        open={false}
        onToggle={toggle}
      >
        <p>body</p>
      </Disclosure>,
    )
    const button = screen.getByRole('button', { name: 'Quota' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Claude 73% left')).toBeVisible()
    expect(screen.queryByText('body')).toBeNull()
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalled()
    rerender(
      <Disclosure
        title="Quota"
        head={{ count: null, line: 'Claude 73% left' }}
        href="/quota"
        where="wide"
        open
        onToggle={toggle}
      >
        <p>body</p>
      </Disclosure>,
    )
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('body')).toBeVisible()
    expect(screen.queryByText('Claude 73% left')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'Open Quota' }))
    expect(state.open).toHaveBeenCalledWith('/quota', 'wide')
  })
})
