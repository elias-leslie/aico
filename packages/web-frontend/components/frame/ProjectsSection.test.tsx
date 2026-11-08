import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attention } from '@/lib/attention'
import type { HistorySession } from '@/lib/history'
import type { ProjectSummary } from '@/lib/projects'
import type { AdHocSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { ProjectsSection } from './ProjectsSection'

const NOW = Date.now()

const hooks = vi.hoisted(() => ({
  attention: {} as Record<string, unknown>,
  overview: {} as Record<string, unknown>,
  history: {} as Record<string, unknown>,
  requestNew: vi.fn(),
}))
vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => hooks.attention,
}))
vi.mock('@/lib/hooks/use-projects', () => ({
  useProjectOverview: () => hooks.overview,
}))
vi.mock('@/lib/hooks/use-history', () => ({
  useHistory: () => hooks.history,
}))
vi.mock('@/lib/hooks/use-session-labels', () => ({
  useSessionLabels: () => (session: { id: string }) => `Chat ${session.id}`,
}))
vi.mock('@/lib/frame/new-session-request', () => ({
  requestNewSession: hooks.requestNew,
}))
vi.mock('@/lib/frame/live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/frame/live')>()),
  useLiveSessions: () => ({
    items: [],
    bySession: new Map(),
    conversations: new Set(),
    failed: false,
    stale: false,
  }),
}))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ agentTools: [] }),
}))
vi.mock('../KeptCheckIns', () => ({ KeptCheckIns: () => null }))

let started = 0
function slot(
  id: string,
  name: string,
  projectKey: string | null,
  extra: Partial<AdHocSlot> = {},
): AdHocSlot {
  started += 1
  return {
    ...SLOT_BASE,
    createdAt: `2026-11-07T00:00:${String(started).padStart(2, '0')}Z`,
    type: 'adhoc',
    sessionId: id,
    name,
    workingDir: null,
    sessionMode: 'codex',
    projectKey,
    ...extra,
  }
}
const state = (group: Attention['group'], at = NOW, age = '1m'): Attention => ({
  group,
  activity: group === 'working' ? 'working' : 'idle',
  at,
  detail: null,
  age,
})
const summary = (id: string, name: string): ProjectSummary => ({
  id,
  name,
  archived: false,
  top: null,
  waiting: null,
  runState: null,
  problems: [],
  agents: 0,
  lastActivity: null,
})
const ended = (id: string, project: string): HistorySession => ({
  id,
  tool: 'codex',
  parentId: null,
  project,
  cwd: null,
  model: null,
  startedAt: NOW - 1000,
  endedAt: NOW - 500,
  outcome: 'completed',
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  toolCalls: 0,
  filesWritten: 0,
})

function setAttention(states: Record<string, Attention>) {
  hooks.attention = {
    forSlot: (s: unknown) => states[(s as AdHocSlot).sessionId] ?? null,
    asksFor: () => ({ blocking: 0, other: 0 }),
    needsYouCount: 0,
    waitingNoAsk: 0,
  }
}
const overviewOk = (data: ProjectSummary[]) => ({
  data,
  isError: false,
  isPending: false,
  refetch: vi.fn(),
})
const view = (slots: AdHocSlot[], onSelect = vi.fn()) =>
  render(<ProjectsSection slots={slots} onSelect={onSelect} />)

beforeEach(() => {
  localStorage.clear()
  hooks.requestNew.mockClear()
  hooks.overview = overviewOk([
    summary('aico', 'Aico'),
    summary('neri', 'Neri'),
    summary('docs', 'Docs'),
    summary('jobs', 'Jobs'),
  ])
  hooks.history = { items: [], failed: false }
  setAttention({})
})

describe('ProjectsSection', () => {
  it('shows a project with one plain session as that one row', () => {
    setAttention({ a: state('working') })
    view([slot('a', 'Tray fix', 'aico')])
    expect(screen.queryByRole('button', { name: /^Aico$/ })).toBeNull()
    const row = screen.getByTestId('project-session')
    expect(row.textContent).toContain('Aico')
    expect(row.textContent).toContain('Tray fix')
    expect(row.textContent).toContain('Working')
  })

  it('heads a project with several sessions, with state chips, working first', () => {
    setAttention({
      a: state('idle'),
      b: state('working'),
      c: state('needs-you'),
    })
    view([
      slot('a', 'Idle one', 'aico'),
      slot('b', 'Busy one', 'aico'),
      slot('c', 'Stuck one', 'aico'),
    ])
    const block = screen.getByRole('region', { name: 'Aico' })
    expect(within(block).getByText('1 waiting')).toBeVisible()
    expect(within(block).getByText('1 working')).toBeVisible()
    const rows = within(block)
      .getAllByTestId('project-session')
      .map((row) => row.querySelector('.name')?.textContent)
    expect(rows).toEqual(['Stuck one', 'Busy one', 'Idle one'])
    fireEvent.click(within(block).getByRole('button', { name: /Aico/ }))
    expect(within(block).queryByTestId('project-session')).toBeNull()
  })

  it('nests a coordinator’s lanes under it and not again under their own project', () => {
    setAttention({ lead: state('working'), lane: state('working') })
    view([
      slot('lead', 'Neri lead', 'neri', { coordinator: true }),
      slot('lane', 'Neri — Scanner', 'docs', { coordinatorId: 'lead' }),
    ])
    expect(screen.queryByRole('region', { name: 'Docs' })).toBeNull()
    // A team with work going is open already; its fold hides it.
    const team = screen.getByRole('group', { name: 'Neri lead team' })
    expect(within(team).getAllByTestId('project-session')).toHaveLength(1)
    expect(screen.getAllByText(/Scanner/)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Hide Neri lead team' }))
    expect(screen.queryByText(/Scanner/)).toBeNull()
  })

  it('folds finished sessions into one line that opens them', () => {
    setAttention({ a: state('working'), b: state('finished') })
    hooks.history = { items: [ended('h1', 'aico')], failed: false }
    view([slot('a', 'Live', 'aico'), slot('b', 'Done', 'aico')])
    const fold = screen.getByRole('button', { name: '2 finished today' })
    expect(screen.queryByText('Done')).toBeNull()
    fireEvent.click(fold)
    expect(screen.getByText('Done')).toBeVisible()
    expect(screen.getByRole('link', { name: /Chat h1/ })).toBeVisible()
  })

  it('folds quiet projects into one line, each with New session here', () => {
    setAttention({ a: state('working') })
    view([slot('a', 'Live', 'aico')])
    const fold = screen.getByRole('button', { name: '3 quiet projects' })
    expect(screen.queryByText('Docs')).toBeNull()
    fireEvent.click(fold)
    fireEvent.click(screen.getByRole('button', { name: 'New session in Docs' }))
    expect(hooks.requestNew).toHaveBeenCalledWith('docs')
  })

  it('says plainly when nothing is running, and when projects could not be read', () => {
    hooks.overview = {
      data: undefined,
      isError: true,
      isPending: false,
      refetch: vi.fn(),
    }
    view([])
    expect(
      screen.getByText('No sessions running. New session starts one.'),
    ).toBeVisible()
    expect(screen.getByRole('alert').textContent).toContain('couldn’t be read')
    expect(screen.queryByText(/quiet project/)).toBeNull()
  })

  it('says it is still checking before it knows which projects are quiet', () => {
    hooks.overview = {
      data: undefined,
      isError: false,
      isPending: true,
      refetch: vi.fn(),
    }
    setAttention({ a: state('working') })
    view([slot('a', 'Live', 'aico')])
    expect(screen.getByRole('status').textContent).toContain(
      'Checking projects',
    )
  })

  it('says finished sessions could not be read', () => {
    hooks.history = { items: [], failed: true }
    view([])
    expect(screen.getByText(/Finished sessions couldn’t be read/)).toBeVisible()
  })

  it('selects a session when its row is clicked', () => {
    setAttention({ a: state('working') })
    const onSelect = vi.fn()
    const a = slot('a', 'Tray fix', 'aico')
    view([a], onSelect)
    fireEvent.click(screen.getByTestId('project-session'))
    expect(onSelect).toHaveBeenCalledWith(a)
  })
})
