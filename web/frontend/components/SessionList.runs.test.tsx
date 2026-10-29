import { fireEvent, render, screen, within } from '@testing-library/react'
import type { RunMember } from 'tether/teams'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Attention, stepAttention } from '@/lib/attention'
import type { WorkflowRuns } from '@/lib/hooks/use-workflow-runs'
import type { AdHocSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { SessionList, SessionRail } from './SessionList'

vi.mock('./KeptCheckIns', () => ({ KeptCheckIns: () => null }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({
    agentTools: [
      { slug: 'codex', name: 'Codex', color: null },
      { slug: 'pi', name: 'Pi', color: null },
      { slug: 'claude-code', name: 'Claude Code', color: null },
    ],
  }),
}))

const lead: AdHocSlot = {
  ...SLOT_BASE,
  createdAt: '2026-10-27T00:00:01Z',
  type: 'adhoc',
  sessionId: 'lead',
  name: 'Aico',
  workingDir: null,
  sessionMode: 'codex',
  coordinator: true,
}

const idle: Attention = {
  group: 'idle',
  activity: 'idle',
  at: 1,
  detail: null,
  age: '1m',
}

const NOW = 1_000_000_000_000

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
    at: NOW - 120_000,
    word: 'running',
    status: 'running',
    url: 'http://hub.test/workflow-runs/r1',
    agent: null,
    tool: null,
    requestedModel: null,
    servedModel: null,
    fallback: false,
    attempt: null,
    attemptLimit: null,
    reason: null,
    can: { decide: false, cancel: true, dismiss: false },
    cancelling: false,
    hint: null,
    progress: '1 of 3 done',
    headline: 'test needs a decision',
    session: false,
    ...extra,
  }
}

const step = (key: string, extra: Partial<RunMember> = {}) =>
  member({
    id: `step:r1:${key}`,
    kind: 'step',
    coordinatorId: 'lead',
    stepKey: key,
    title: key,
    tool: 'pi',
    group: 'working',
    word: 'tool bash',
    status: 'running',
    requestedModel: 'opencode-go/deepseek-v4.1-flash',
    attempt: 2,
    attemptLimit: 3,
    progress: null,
    headline: null,
    session: true,
    ...extra,
  })

function attention(items: RunMember[], slots: AdHocSlot[] = [lead]) {
  const runs: WorkflowRuns = {
    items,
    state: 'ok',
    notice: null,
    needsYouCount: items.filter(
      (m) => m.kind === 'run' && m.group === 'needs-you',
    ).length,
  }
  return {
    forSlot: (s: unknown) => (slots.includes(s as AdHocSlot) ? idle : null),
    forStep: (m: RunMember) => stepAttention(m, NOW),
    needsYouCount: runs.needsYouCount,
    runs,
  }
}

beforeEach(() => localStorage.clear())

describe('running workflow steps in the session list', () => {
  it('shows a running step as a child agent of the session that launched the run, like any other', () => {
    render(
      <SessionList
        slots={[lead]}
        attention={attention([member({}), step('build')])}
        onSelect={vi.fn()}
      />,
    )
    const team = screen.getByRole('group', { name: 'Aico team' })
    const rows = team.querySelectorAll('.lantern-row')
    expect(rows).toHaveLength(1)
    const row = rows[0] as HTMLElement
    expect(row.querySelector('.name')?.textContent).toBe('build')
    expect(row.querySelector('.meta')?.textContent).toBe('Pi · working')
    expect(row.querySelector('.when')?.textContent).toBe('2m')
    expect(row.querySelector('[data-agent-icon="pi"]')).not.toBeNull()
    // No model, tries, progress, run goal or controls.
    expect(team.textContent).not.toMatch(
      /deepseek|try 2|1 of 3|Ship the thing|details/i,
    )
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(within(team).getAllByRole('button')).toHaveLength(1)
    // The coordinator's own row counts its child.
    expect(screen.getByRole('button', { name: /^Aico/ }).textContent).toContain(
      '1 working',
    )
  })

  it('shows a run with no running step as nothing at all', () => {
    const { container } = render(
      <SessionList
        slots={[lead]}
        attention={attention([
          member({ group: 'working' }),
          step('wait-for-it', {
            group: 'idle',
            status: 'pending',
            word: 'pending',
          }),
          step('done', { group: 'idle', status: 'completed', word: 'done' }),
          step('skipped', {
            group: 'idle',
            status: 'skipped',
            word: 'skipped',
          }),
          step('cut', {
            group: 'no-status',
            status: 'cancelled',
            word: 'cancelled',
          }),
          step('broke', {
            group: 'no-status',
            status: 'failed',
            word: 'failed',
          }),
        ])}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.queryByRole('group', { name: 'Aico team' })).toBeNull()
    expect(container.querySelectorAll('.lantern-row')).toHaveLength(1)
    expect(container.textContent).not.toMatch(
      /Ship the thing|wait-for-it|broke/,
    )
  })

  it('gives a step waiting for the owner the needs-you treatment, including a failed step that paused the run', () => {
    const { container } = render(
      <SessionList
        slots={[lead]}
        attention={attention([
          member({ group: 'needs-you', status: 'needs_owner' }),
          step('fix', {
            group: 'needs-you',
            status: 'failed',
            word: 'waiting for you',
            tool: 'claude-code',
          }),
        ])}
        onSelect={vi.fn()}
      />,
    )
    // The coordinator is highlighted while its team is folded or not; the open lane is.
    const rows = [...container.querySelectorAll('.lantern-lanes .lantern-row')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.className).toContain('needs')
    expect(rows[0]?.querySelector('.meta')?.textContent).toBe(
      'Claude Code is waiting for you',
    )
    expect(
      rows[0]?.querySelector('[data-agent-icon="claude-code"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('.lantern-row.lead')?.className,
    ).not.toContain('needs')
  })

  it('opens the step through onOpenStep and does not select a session', () => {
    const onSelect = vi.fn()
    const onOpenStep = vi.fn()
    const build = step('build')
    render(
      <SessionList
        slots={[lead]}
        attention={attention([member({}), build])}
        onSelect={onSelect}
        onOpenStep={onOpenStep}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^build/ }))
    expect(onOpenStep).toHaveBeenCalledWith(build)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps a step whose session ended at the top, marked', () => {
    render(
      <SessionList
        slots={[]}
        attention={attention([member({}), step('build')], [])}
        onSelect={vi.fn()}
      />,
    )
    const row = screen.getByRole('button', { name: /^build/ })
    expect(row.textContent).toContain('Pi · working · coordinator ended')
  })

  it('says when the runs may be out of date', () => {
    const base = attention([member({})])
    render(
      <SessionList
        slots={[lead]}
        attention={{
          ...base,
          runs: {
            ...base.runs,
            state: 'stale',
            notice:
              'Workflow runs may be out of date: Agent Hub is not reachable',
          },
        }}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe(
      'Workflow runs may be out of date: Agent Hub is not reachable',
    )
  })

  it('marks the rail item of a session whose step waits, with no mark for the step itself', () => {
    const { container } = render(
      <SessionRail
        slots={[lead]}
        attention={attention([
          member({ group: 'needs-you' }),
          step('fix', { group: 'needs-you', word: 'waiting for you' }),
        ])}
        onSelect={vi.fn()}
      />,
    )
    const items = [...container.querySelectorAll('.lantern-rail-item')]
    expect(items).toHaveLength(1)
    expect(items[0]?.className).toContain('needs')
  })
})
