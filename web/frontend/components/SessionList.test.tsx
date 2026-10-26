import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attention } from '@/lib/attention'
import type { AdHocSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { SessionList, sessionsHeading } from './SessionList'

vi.mock('./KeptCheckIns', () => ({ KeptCheckIns: () => null }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ agentTools: [] }),
}))

function slot(
  id: string,
  name: string,
  extra: Partial<AdHocSlot> = {},
): AdHocSlot {
  return {
    ...SLOT_BASE,
    type: 'adhoc',
    sessionId: id,
    name,
    workingDir: null,
    sessionMode: 'codex',
    ...extra,
  }
}

function state(group: Attention['group'], at: number, age = '1m'): Attention {
  const activity =
    group === 'needs-you' ? 'blocked' : group === 'working' ? 'working' : 'idle'
  return { group, activity, at, detail: null, age }
}

const lead = slot('lead', 'Neri — Daybreak lead', {
  coordinator: true,
  badge: { label: 'Coordinator', color: '#6fa8ff' },
  checkIns: [{ id: 'w2', due_at: 600, time: '6:00 PM' }],
})
const ask = slot('ask', 'Neri — Matomo pair lead', {
  coordinatorId: 'lead',
  badge: { label: '↳ Daybreak lead', color: '#6fa8ff' },
})
const busy = slot('busy', 'Neri — Scanner', {
  coordinatorId: 'lead',
  checkIns: [{ id: 'w1', due_at: 500, time: '5:30 PM' }],
})
const done = slot('done', 'Neri — Report', { coordinatorId: 'lead' })
const left = slot('left', 'Docs — Notes', {
  coordinatorId: 'gone',
  badge: { label: '↳ Old lead', color: '#6fa8ff' },
})
const solo = slot('solo', 'Aico — Tray')

const states: Record<string, Attention> = {
  lead: state('working', 1),
  ask: state('needs-you', 2),
  busy: state('working', 3),
  done: state('finished', 4),
  left: state('idle', 5),
  solo: state('working', 6),
}
const attention = {
  forSlot: (s: unknown) => states[(s as AdHocSlot).sessionId] ?? null,
  needsYouCount: 1,
}
const slots = [lead, ask, busy, done, left, solo]

function rowNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.lantern-row .name')].map(
    (el) => el.textContent ?? '',
  )
}

describe('SessionList teams', () => {
  beforeEach(() => localStorage.clear())

  it('folds lanes on a phone: the team sits in Needs you with its summary and earliest check-in', () => {
    const { container } = render(
      <SessionList
        slots={slots}
        attention={attention}
        onSelect={vi.fn()}
        phone
      />,
    )
    expect(
      [
        ...container.querySelectorAll('[data-testid="session-group-header"]'),
      ].map((el) => el.textContent),
    ).toEqual(['Needs you1', 'Working1', 'Idle1'])
    expect(rowNames(container)).toEqual([
      'Neri — Daybreak lead',
      'Aico — Tray',
      'Docs — Notes',
    ])
    const team = container.querySelector('.lantern-row.lead') as HTMLElement
    expect(team.className).toContain('needs')
    expect(team.textContent).toContain(
      'Coordinator1 working, 1 needs you, 1 idle',
    )
    expect(within(team).getByTestId('check-in-badge').textContent).toContain(
      'Check-in 5:30 PM',
    )
    // A lane whose coordinator ended is back at the top level, marked.
    expect(
      screen.getByRole('button', { name: /Docs — Notes/ }).textContent,
    ).toContain('coordinator ended')
  })

  it('opens a team: lanes sorted, prefix dropped, the waiting lane highlighted', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <SessionList
        slots={slots}
        attention={attention}
        onSelect={onSelect}
        phone
      />,
    )
    const toggle = screen.getByRole('button', {
      name: 'Show Neri — Daybreak lead team',
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const lanes = screen.getByRole('group', {
      name: 'Neri — Daybreak lead team',
    })
    expect(rowNames(lanes)).toEqual(['Matomo pair lead', 'Scanner', 'Report'])
    const waiting = lanes.querySelector('.lantern-row') as HTMLElement
    expect(waiting.className).toContain('needs')
    expect(waiting.textContent).not.toContain('↳')
    // Open, the lead row no longer carries the lane's highlight.
    expect(
      container.querySelector('.lantern-row.lead')?.className,
    ).not.toContain('needs')
    // Each session appears once.
    expect(rowNames(container)).toHaveLength(slots.length)
    fireEvent.click(within(lanes).getByRole('button', { name: /Scanner/ }))
    expect(onSelect).toHaveBeenCalledWith(busy)
  })

  it('remembers a folded team per coordinator on a desktop', () => {
    const { unmount } = render(
      <SessionList slots={slots} attention={attention} onSelect={vi.fn()} />,
    )
    // Desktop teams start open.
    fireEvent.click(
      screen.getByRole('button', { name: 'Hide Neri — Daybreak lead team' }),
    )
    unmount()
    render(
      <SessionList slots={slots} attention={attention} onSelect={vi.fn()} />,
    )
    expect(
      screen
        .getByRole('button', { name: 'Show Neri — Daybreak lead team' })
        .getAttribute('aria-expanded'),
    ).toBe('false')
  })
})

describe('sessionsHeading', () => {
  it('counts sessions and says when any need you', () => {
    expect(sessionsHeading(5, 0)).toBe('Sessions · 5')
    expect(sessionsHeading(5, 1)).toBe('Sessions · 5 · 1 needs you')
    expect(sessionsHeading(5, 2)).toBe('Sessions · 5 · 2 need you')
  })
})
