import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { useTerminalSlotHandlers } from './use-terminal-slot-handlers'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function paneSlot(id: string): PaneSlot {
  return {
    type: 'adhoc',
    ...SLOT_BASE,
    paneId: `pane-${id}`,
    sessionId: `session-${id}`,
    name: `Session ${id}`,
    workingDir: '/tmp',
    sessionMode: 'shell',
  }
}

function setup(nextSessionId: string | null = null) {
  const switchToSession = vi.fn()
  const clearActiveSession = vi.fn()
  const remove = vi.fn().mockResolvedValue({
    deleted: true,
    id: 'session-a',
    next_session_id: nextSessionId,
    pane_id: 'pane-a',
    pane_deleted: nextSessionId === null,
    is_external: false,
  })
  const { result } = renderHook(
    () =>
      useTerminalSlotHandlers({
        switchToSession,
        clearActiveSession,
        activeSessionId: 'session-a',
        reset: vi.fn(),
        remove,
        sessions: [],
        handleProjectModeChange: vi.fn(),
      }),
    { wrapper: createWrapper() },
  )
  return { result, switchToSession, clearActiveSession, remove }
}

describe('useTerminalSlotHandlers', () => {
  it('after ending the open session, shows no session rather than another pane', async () => {
    // Panes are shared: the next one may be the owner's or another agent's.
    const { result, switchToSession, clearActiveSession, remove } = setup()

    await act(async () => {
      await result.current.handleSlotCloseSession(paneSlot('a'))
    })

    expect(remove).toHaveBeenCalledWith('session-a', {})
    expect(switchToSession).not.toHaveBeenCalled()
    expect(clearActiveSession).toHaveBeenCalled()
  })

  it("shows the session's companion in its pane, as the backend names it", async () => {
    const { result, switchToSession, clearActiveSession } = setup('session-c')

    await act(async () => {
      await result.current.handleSlotCloseSession(paneSlot('a'))
    })

    expect(switchToSession).toHaveBeenCalledWith('session-c')
    expect(clearActiveSession).not.toHaveBeenCalled()
  })

  it('leaves the view alone when a session that is not open ends', async () => {
    const { result, switchToSession, clearActiveSession } = setup()

    await act(async () => {
      await result.current.handleSlotCloseSession(paneSlot('b'))
    })

    expect(switchToSession).not.toHaveBeenCalled()
    expect(clearActiveSession).not.toHaveBeenCalled()
  })
})
