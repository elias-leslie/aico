import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneSlot } from '../utils/slot'
import type { ATermSession } from './use-a-term-sessions'
import { useSessionAttention } from './use-session-attention'

// Sessions started from the web are detached; only the list that includes
// them knows about them.
const detachedSession = {
  id: 'session-a',
  pane_id: 'pane-a',
  activity: 'blocked',
  activity_at: Date.now(),
} as unknown as ATermSession

vi.mock('./use-a-term-sessions', () => ({
  useATermSessions: (options?: { includeDetached?: boolean }) => ({
    sessions: options?.includeDetached ? [detachedSession] : [],
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
