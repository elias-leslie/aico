import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneSlot } from '@/lib/utils/slot'
import { useATermSlotHandlers } from './use-a-term-slot-handlers'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

const slot: PaneSlot = {
  type: 'adhoc',
  paneId: 'pane-a',
  sessionId: 'session-a',
  name: 'Detached A-Term',
  workingDir: '/tmp',
  sessionMode: 'shell',
}

const otherSlot: PaneSlot = {
  type: 'adhoc',
  paneId: 'pane-b',
  sessionId: 'session-b',
  name: 'Other Detached A-Term',
  workingDir: '/tmp',
  sessionMode: 'shell',
}

describe('useATermSlotHandlers', () => {
  beforeEach(() => {
    window.history.replaceState(
      null,
      '',
      '/?windowScope=scope-old&detachedPane=pane-a&windowPanes=pane-a&session=session-a',
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
  })

  it('detaches a pane from an existing detached window into a fresh popup target', async () => {
    const detachPane = vi.fn()
    const removeDetachedWindowPane = vi.fn()
    const popup = {
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      location: { href: '' },
    }
    const openMock = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as Window)
    const switchToSession = vi.fn()

    const { result } = renderHook(
      () =>
        useATermSlotHandlers({
          aTermRefs: { current: new Map() },
          switchToSession,
          activeSessionId: 'session-a',
          reset: vi.fn(),
          disableProject: vi.fn(),
          remove: vi.fn(),
          detachExternalSession: vi.fn(),
          detachPane,
          removePane: vi.fn(),
          setShowCleaner: vi.fn(),
          setCleanerRawPrompt: vi.fn(),
          sessions: [],
          visibleSlots: [slot, otherSlot],
          handleProjectModeChange: vi.fn(),
          isDetachedPaneWindow: true,
          removeDetachedWindowPane,
        }),
      { wrapper: createWrapper() },
    )

    await act(async () => {
      await result.current.handleSlotDetach(slot)
    })

    const [, popupName] = openMock.mock.calls[0]
    const popupParams = new URL(popup.location.href, 'http://localhost')
      .searchParams

    expect(detachPane).not.toHaveBeenCalled()
    expect(removeDetachedWindowPane).toHaveBeenCalledWith('pane-a', 'session-b')
    expect(switchToSession).not.toHaveBeenCalled()
    expect(popupName).not.toBe('a-term-detached-pane-pane-a')
    expect(popupParams.get('detachedPane')).toBe('pane-a')
    expect(popupParams.get('windowPanes')).toBe('pane-a')
    expect(popupParams.get('windowScope')).toBeTruthy()
    expect(popupParams.get('windowScope')).not.toBe('scope-old')
    expect(popup.focus).toHaveBeenCalled()
  })
})
