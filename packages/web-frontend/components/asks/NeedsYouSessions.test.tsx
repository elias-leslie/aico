// Needs you is one list: questions, access requests and sessions stopped for the owner, one count.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attention } from '@/lib/attention'
import type { AdHocSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { NeedsYouSection } from './NeedsYou'

const state = vi.hoisted(() => ({ attention: {} as Record<string, unknown> }))
vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => state.attention,
}))
vi.mock('@/lib/hooks/use-asks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/use-asks')>()),
  useOwnerAsks: () => ({
    asks: [],
    known: true,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  useApprovals: () => ({
    approvals: { state: 'ok', taps: [] },
    known: true,
    isLoading: false,
  }),
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

const slot = (id: string, name: string): AdHocSlot => ({
  ...SLOT_BASE,
  createdAt: '2026-11-07T00:00:01Z',
  type: 'adhoc',
  sessionId: id,
  name,
  workingDir: null,
  sessionMode: 'codex',
  projectLabel: 'Aico',
})
const waiting: Attention = {
  group: 'needs-you',
  activity: 'blocked',
  at: 1,
  detail: null,
  age: '2m',
}

beforeEach(() => {
  state.attention = {
    forSlot: (s: unknown) =>
      (s as AdHocSlot).sessionId === 'w' ? waiting : null,
    asksFor: () => ({ blocking: 0, other: 0 }),
    needsYouCount: 1,
    waitingNoAsk: 1,
  }
})

describe('Needs you with sessions', () => {
  it('lists a session waiting on the owner and counts it', () => {
    const onSelect = vi.fn()
    const w = slot('w', 'Disk merge')
    render(
      <NeedsYouSection slots={[w, slot('x', 'Other')]} onSelect={onSelect} />,
    )
    const row = screen.getByRole('button', { name: /^Needs you/ })
    expect(row).toHaveTextContent('1 waiting')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const session = screen.getByTestId('project-session')
    expect(session.textContent).toContain('Disk merge')
    expect(session.textContent).toContain('Waiting for you')
    expect(session.textContent).toContain('Aico')
    expect(screen.queryByText('Other')).toBeNull()
    fireEvent.click(session)
    expect(onSelect).toHaveBeenCalledWith(w)
  })

  it('has nothing to list when no session waits', () => {
    state.attention = { ...state.attention, forSlot: () => null }
    render(<NeedsYouSection slots={[slot('w', 'Disk merge')]} />)
    expect(screen.queryByTestId('project-session')).toBeNull()
    expect(screen.getByRole('button', { name: /^Needs you/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })
})
