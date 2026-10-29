import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { RunMember } from 'tether/teams'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attention } from '@/lib/attention'
import type { WorkflowRuns } from '@/lib/hooks/use-workflow-runs'
import type { AdHocSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { SessionList, SessionRail } from './SessionList'

vi.mock('./KeptCheckIns', () => ({ KeptCheckIns: () => null }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ agentTools: [] }),
}))

const lead: AdHocSlot = {
  ...SLOT_BASE,
  createdAt: '2026-10-27T00:00:01Z',
  type: 'adhoc',
  sessionId: 'lead',
  name: 'Aico — Lead',
  workingDir: null,
  sessionMode: 'codex',
  coordinator: true,
}

const working: Attention = {
  group: 'working',
  activity: 'working',
  at: 1,
  detail: null,
  age: '1m',
}

const URL = 'http://hub.test/workflow-runs/r1'

function member(extra: Partial<RunMember>): RunMember {
  return {
    id: 'run:r1',
    kind: 'run',
    coordinator: false,
    coordinatorId: 'lead',
    runId: 'r1',
    stepKey: null,
    title: 'Ship the thing',
    group: 'working',
    at: Date.now() - 120_000,
    word: 'running',
    status: 'running',
    url: URL,
    agent: null,
    requestedModel: null,
    servedModel: null,
    fallback: false,
    attempt: null,
    attemptLimit: null,
    reason: null,
    can: { decide: false, cancel: true, dismiss: false },
    cancelling: false,
    hint: null,
    summary: '1 of 3 done',
    progress: '1 of 3 done',
    headline: 'test needs a decision',
    session: false,
    ...extra,
  }
}

const build = member({
  id: 'step:r1:build',
  kind: 'step',
  coordinatorId: 'run:r1',
  stepKey: 'build',
  title: 'build',
  group: 'working',
  word: 'tool bash',
  requestedModel: 'opencode-go/deepseek-v4.1-flash',
  servedModel: 'opencode-go/other',
  fallback: true,
  attempt: 2,
  attemptLimit: 3,
  hint: null,
  summary: null,
  progress: null,
  headline: null,
  session: true,
})
const test = member({
  id: 'step:r1:test',
  kind: 'step',
  coordinatorId: 'run:r1',
  stepKey: 'test',
  title: 'test',
  group: 'needs-you',
  word: 'waiting for you',
  status: 'failed',
  reason: 'step failed',
  hint: null,
  summary: null,
  progress: null,
  headline: null,
  session: true,
  can: { decide: true, cancel: true, dismiss: false },
})

function runs(
  items: RunMember[],
  extra: Partial<WorkflowRuns> = {},
): WorkflowRuns & { act: ReturnType<typeof vi.fn> } {
  return {
    items,
    state: 'ok',
    notice: null,
    needsYouCount: items.filter(
      (m) => m.kind === 'run' && m.group === 'needs-you',
    ).length,
    act: vi.fn(async () => {}),
    ...extra,
  } as WorkflowRuns & { act: ReturnType<typeof vi.fn> }
}

const attention = (r: WorkflowRuns, slots: AdHocSlot[] = [lead]) => ({
  forSlot: (s: unknown) => (slots.includes(s as AdHocSlot) ? working : null),
  needsYouCount: r.needsYouCount,
  runs: r,
})

beforeEach(() => localStorage.clear())

const open = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }))

describe('workflow runs in the session list', () => {
  it('folds a run under the session that launched it as one line, steps hidden', () => {
    const r = runs([
      member({ group: 'needs-you', word: 'waiting for you' }),
      build,
      test,
    ])
    render(
      <SessionList
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
      />,
    )
    const team = screen.getByRole('group', { name: 'Aico — Lead team' })
    const run = within(team).getByTestId('run-run')
    expect(run.textContent).toContain('Ship the thing')
    expect(run.textContent).toContain('1 of 3 done · test needs a decision')
    expect(run.textContent).toContain('2m')
    expect(
      within(run).queryByRole('group', { name: 'Steps of Ship the thing' }),
    ).toBeNull()
    expect(within(run).queryAllByTestId('run-step')).toHaveLength(0)
    expect(screen.queryByText(/Dismiss/)).toBeNull()
    expect(run.querySelector('.lantern-row')?.className).toContain('needs')
  })

  it('opens a run to its steps, the waiting one first, and folds it again', () => {
    const r = runs([
      member({ group: 'needs-you', word: 'waiting for you' }),
      build,
      test,
    ])
    render(
      <SessionList
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
      />,
    )
    const toggle = screen.getByRole('button', { name: /Show steps\./ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    const steps = screen.getByRole('group', { name: 'Steps of Ship the thing' })
    const rows = within(steps).getAllByTestId('run-step')
    expect(rows.map((el) => el.querySelector('.name')?.textContent)).toEqual([
      'test',
      'build',
    ])
    expect(rows[0]?.textContent).toContain('waiting for you · step failed')
    expect(rows[1]?.textContent).toContain(
      'deepseek-v4.1-flash → other · fallback · tool bash · try 2 of 3',
    )
    const hide = screen.getByRole('button', { name: /Hide steps\./ })
    expect(hide.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(hide)
    expect(
      screen.queryByRole('group', { name: 'Steps of Ship the thing' }),
    ).toBeNull()
  })

  it('opens the run in Agent Hub from a small details link, and only for a web address', () => {
    const r = runs([
      member({}),
      member({ id: 'run:r2', runId: 'r2', url: 'javascript:alert(1)' }),
    ])
    render(
      <SessionList
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
      />,
    )
    const link = screen.getByRole('link', {
      name: /Details of workflow run Ship the thing/,
    })
    expect(link.textContent).toBe('details')
    expect(link.getAttribute('href')).toBe(URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('highlights a folded session whose run waits, and counts it in the heading numbers', () => {
    const r = runs([
      member({ group: 'needs-you', word: 'waiting for you' }),
      test,
    ])
    const { container } = render(
      <SessionList
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
        phone
      />,
    )
    expect(container.querySelector('.lantern-row.lead')?.className).toContain(
      'needs',
    )
  })

  it('leaves the answers to the coordinator while it lives: no Retry, Skip, Fail or Dismiss', () => {
    const r = runs([
      member({ group: 'needs-you', word: 'waiting for you' }),
      test,
    ])
    render(
      <SessionList
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Show steps\./ }))
    expect(screen.getAllByTestId('run-step')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Fail/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull()
    // Cancel stays on the opened run.
    expect(
      screen.getByRole('button', { name: 'Cancel run Ship the thing' }),
    ).toBeTruthy()
  })

  it('answers a waiting step once its coordinator has ended: Retry and Skip at once, Fail after a confirmation', async () => {
    const r = runs([
      member({
        coordinatorId: 'gone',
        group: 'needs-you',
        word: 'waiting for you',
      }),
      test,
    ])
    render(
      <SessionList
        slots={[]}
        attention={attention(r, [])}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Show steps\./ }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry step test' }))
    await waitFor(() =>
      expect(r.act).toHaveBeenCalledWith({
        type: 'resume',
        member: test,
        action: 'retry',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Skip step test' }))
    await waitFor(() =>
      expect(r.act).toHaveBeenCalledWith({
        type: 'resume',
        member: test,
        action: 'skip',
      }),
    )
    r.act.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Fail step test' }))
    expect(r.act).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() =>
      expect(r.act).toHaveBeenCalledWith({
        type: 'resume',
        member: test,
        action: 'fail',
      }),
    )
  })

  it('cancels a run only after a confirmation, and says when Agent Hub refuses', async () => {
    const r = runs([member({}), build])
    r.act.mockRejectedValueOnce(
      new Error('Agent Hub did not accept it (step is running)'),
    )
    render(
      <SessionList
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Show steps\./ }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel run Ship the thing' }),
    )
    expect(screen.getByText('Cancel run Ship the thing?')).toBeTruthy()
    expect(r.act).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Agent Hub did not accept it',
      ),
    )
  })

  it('gives an ended run no controls, only its steps and details', () => {
    const ended = member({
      id: 'run:r9',
      runId: 'r9',
      title: 'Old run',
      group: 'finished',
      word: 'completed',
      status: 'completed',
      progress: '2 of 2 done',
      headline: 'finished',
      summary: '2 of 2 done',
      can: { decide: false, cancel: false, dismiss: true },
    })
    const endedStep = member({
      id: 'step:r9:a',
      kind: 'step',
      coordinatorId: 'run:r9',
      runId: 'r9',
      stepKey: 'a',
      title: 'a',
      group: 'idle',
      word: 'done',
      status: 'completed',
      hint: null,
      summary: null,
      progress: null,
      headline: null,
      session: true,
      can: { decide: false, cancel: false, dismiss: false },
    })
    const r = runs([ended, endedStep])
    render(
      <SessionList
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByTestId('run-run').textContent).toContain(
      '2 of 2 done · finished',
    )
    open('Show steps')
    expect(screen.getAllByTestId('run-step')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
  })

  it('keeps a run whose session ended at the top, marked', () => {
    const r = runs([member({ coordinatorId: 'gone' })])
    render(
      <SessionList
        slots={[]}
        attention={attention(r, [])}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByTestId('run-run').textContent).toContain(
      'coordinator ended',
    )
  })

  it('says when the runs may be out of date', () => {
    const r = runs([member({})], {
      state: 'stale',
      notice: 'Workflow runs may be out of date: Agent Hub is not reachable',
    })
    render(
      <SessionList
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe(
      'Workflow runs may be out of date: Agent Hub is not reachable',
    )
  })

  it('marks the rail item of a session whose run waits, and lists an orphaned run on its own', () => {
    const waiting = member({ group: 'needs-you', word: 'waiting for you' })
    const orphan = member({
      id: 'run:r5',
      runId: 'r5',
      title: 'Left over',
      coordinatorId: 'gone',
    })
    const r = runs([waiting, orphan])
    const { container } = render(
      <SessionRail
        slots={[lead]}
        attention={attention(r)}
        onSelect={vi.fn()}
      />,
    )
    const items = [...container.querySelectorAll('.lantern-rail-item')]
    expect(items).toHaveLength(2)
    expect(items[0]?.className).toContain('needs')
    expect(items[1]?.getAttribute('aria-label')).toContain(
      'Workflow run Left over',
    )
    expect(items[1]?.getAttribute('href')).toBe(URL)
  })
})
