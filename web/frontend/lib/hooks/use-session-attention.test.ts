import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneSlot } from '../utils/slot'
import { useSessionAttention } from './use-session-attention'
import type { TerminalSession } from './use-terminal-sessions'

// Sessions started from the web are detached; only the list that includes
// them knows about them.
const detachedSession = {
  id: 'session-a',
  pane_id: 'pane-a',
  activity: 'blocked',
  activity_at: Date.now(),
} as unknown as TerminalSession

vi.mock('./use-terminal-sessions', () => ({
  useTerminalSessions: (options?: { includeDetached?: boolean }) => ({
    sessions: options?.includeDetached ? [detachedSession] : [],
  }),
}))

vi.mock('./use-workflow-runs', () => ({
  useWorkflowRuns: () => ({
    items: [],
    state: 'ok',
    notice: null,
    needsYouCount: 0,
    act: async () => {},
  }),
}))

describe('useSessionAttention', () => {
  it('knows the state of sessions started from the web', () => {
    const { result } = renderHook(() => useSessionAttention())
    const slot = {
      type: 'project',
      paneId: 'pane-a',
      activeSessionId: 'session-a',
    } as unknown as PaneSlot

    expect(result.current.forSlot(slot)?.group).toBe('needs-you')
    expect(result.current.needsYouCount).toBe(1)
  })
})
