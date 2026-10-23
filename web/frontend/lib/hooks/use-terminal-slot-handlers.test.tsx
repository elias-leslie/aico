import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
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

const externalSlot: TerminalSlot = {
  type: 'adhoc',
  ...SLOT_BASE,
  sessionId: 'session-agent',
  name: 'Agent session',
  workingDir: '/tmp',
  sessionMode: 'shell',
  isExternal: true,
}

function setup(
  slots: Array<TerminalSlot | PaneSlot>,
  nextSessionId: string | null = null,
) {
  const switchToSession = vi.fn()
  const remove = vi.fn().mockResolvedValue({
    deleted: true,
    id: 'session-a',
    next_session_id: nextSessionId,
    pane_id: 'pane-a',
    pane_deleted: true,
    is_external: false,
  })
  const { result } = renderHook(
    () =>
      useTerminalSlotHandlers({
        switchToSession,
        activeSessionId: 'session-a',
        reset: vi.fn(),
        remove,
        sessions: [],
        slots,
        handleProjectModeChange: vi.fn(),
      }),
    { wrapper: createWrapper() },
  )
  return { result, switchToSession, remove }
}

describe('useTerminalSlotHandlers', () => {
  it("after ending the open session, shows the user's next own session", async () => {
    const a = paneSlot('a')
    const { result, switchToSession, remove } = setup([
      a,
      externalSlot,
      paneSlot('b'),
    ])

    await act(async () => {
      await result.current.handleSlotCloseSession(a)
    })

    expect(remove).toHaveBeenCalledWith('session-a')
    expect(switchToSession).toHaveBeenCalledWith('session-b')
  })

  it('prefers the session the backend names next', async () => {
    const a = paneSlot('a')
    const { result, switchToSession } = setup([a, paneSlot('b')], 'session-c')

    await act(async () => {
      await result.current.handleSlotCloseSession(a)
    })

    expect(switchToSession).toHaveBeenCalledWith('session-c')
  })

  it("never opens another agent's session after the last own one ends", async () => {
    const a = paneSlot('a')
    const { result, switchToSession } = setup([a, externalSlot])

    await act(async () => {
      await result.current.handleSlotCloseSession(a)
    })

    expect(switchToSession).not.toHaveBeenCalled()
  })
})
