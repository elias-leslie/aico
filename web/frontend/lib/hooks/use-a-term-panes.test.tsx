import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_BASE } from '@/test-stubs/session-fixtures'
import * as api from './a-term-panes-api'
import type { ATermPane, PaneListResponse } from './a-term-panes-types'
import { useATermPanes } from './use-a-term-panes'

vi.mock('./a-term-panes-api')

const detachedPane: ATermPane = {
  id: 'pane-detached',
  pane_type: 'project',
  project_id: 'project-a',
  pane_order: 1,
  pane_name: 'Project A',
  active_mode: 'shell',
  is_detached: true,
  created_at: '2026-03-06T00:00:00Z',
  sessions: [
    {
      id: 'session-a',
      name: 'Project A Shell',
      mode: 'shell',
      ...SESSION_BASE,
      session_number: 1,
      is_alive: true,
      working_dir: '/workspace/project-a',
      claude_state: 'not_started',
    },
  ],
  width_percent: 100,
  height_percent: 100,
  grid_row: 0,
  grid_col: 0,
}

const attachedPane: ATermPane = { ...detachedPane, is_detached: false }

function paneList(items: ATermPane[]): PaneListResponse {
  return { items, total: items.length, max_panes: 6 }
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('useATermPanes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.fetchPanes).mockResolvedValue(paneList([]))
    vi.mocked(api.fetchDetachedPanes).mockResolvedValue(
      paneList([detachedPane]),
    )
  })

  it('moves an attached pane into the active cache immediately', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    queryClient.setQueryData(['a-term-panes'], paneList([]))
    queryClient.setQueryData(
      ['a-term-detached-panes'],
      paneList([detachedPane]),
    )
    queryClient.setQueryData(['a-term-sessions', false], [])
    queryClient.setQueryData(['a-term-sessions', true], [])
    vi.mocked(api.attachPane).mockResolvedValue(attachedPane)
    vi.mocked(api.fetchPanes).mockResolvedValue(paneList([attachedPane]))
    vi.mocked(api.fetchDetachedPanes).mockResolvedValue(paneList([]))

    const { result } = renderHook(() => useATermPanes(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.attachPane('pane-detached')
    })

    await waitFor(() => {
      expect(
        queryClient.getQueryData<PaneListResponse>(['a-term-panes'])?.items,
      ).toEqual([attachedPane])
      expect(
        queryClient.getQueryData<PaneListResponse>(['a-term-detached-panes'])
          ?.items,
      ).toEqual([])
      expect(
        queryClient
          .getQueryData<Array<{ id: string }>>(['a-term-sessions', false])
          ?.map((session) => session.id),
      ).toEqual(['session-a'])
      expect(
        queryClient
          .getQueryData<Array<{ id: string }>>(['a-term-sessions', true])
          ?.map((session) => session.id),
      ).toEqual(['session-a'])
    })
  })

  it("takes the pane limit from the backend's pane list, capped by the layouts", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.mocked(api.fetchPanes).mockResolvedValue({
      ...paneList([attachedPane]),
      max_panes: 1,
    })
    const { result } = renderHook(() => useATermPanes(), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.maxPanes).toBe(1))
    expect(result.current.atLimit).toBe(true)

    vi.mocked(api.fetchPanes).mockResolvedValue({
      ...paneList([attachedPane]),
      max_panes: 9,
    })
    await act(async () => {
      await queryClient.refetchQueries()
    })
    // No layout arranges more than six.
    await waitFor(() => expect(result.current.maxPanes).toBe(6))
  })
})
