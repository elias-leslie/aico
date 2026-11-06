import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_BASE } from '@/test-stubs/session-fixtures'
import { apiFetch } from '../api-fetch'
import {
  type PaneListResponse,
  type TerminalPane,
  usePaneListError,
  useTerminalPanes,
} from './use-terminal-panes'

vi.mock('../api-fetch', () => ({ apiFetch: vi.fn() }))

/** The server, by request: `GET /api/panes`, `POST /api/panes`, ... */
const server = new Map<string, () => Promise<unknown>>()
function serve(route: string, reply: () => Promise<unknown>) {
  server.set(route, reply)
}

const detachedPane: TerminalPane = {
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
}

function paneList(items: TerminalPane[]): PaneListResponse {
  return { items, total: items.length }
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('useTerminalPanes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    server.clear()
    vi.mocked(apiFetch).mockImplementation((url, options) => {
      const reply = server.get(`${options?.method ?? 'GET'} ${url}`)
      return reply ? (reply() as never) : Promise.reject(new Error(url))
    })
    serve('GET /api/panes', async () => paneList([]))
    serve('GET /api/panes/detached', async () => paneList([detachedPane]))
  })

  it('puts a new detached pane in the detached cache and the full session list at once', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    queryClient.setQueryData(['terminal-panes'], paneList([]))
    queryClient.setQueryData(['terminal-detached-panes'], paneList([]))
    queryClient.setQueryData(['terminal-sessions', false], [])
    queryClient.setQueryData(['terminal-sessions', true], [])
    serve('POST /api/panes', async () => detachedPane)

    const { result } = renderHook(() => useTerminalPanes(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.createProjectPane(
        'Project A',
        'project-a',
        '/workspace/project-a',
        undefined,
        { detached: true },
      )
    })

    const create = vi
      .mocked(apiFetch)
      .mock.calls.find(([, options]) => options?.method === 'POST')
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      project_id: 'project-a',
      detached: true,
    })
    await waitFor(() => {
      expect(
        queryClient.getQueryData<PaneListResponse>(['terminal-panes'])?.items,
      ).toEqual([])
      expect(
        queryClient.getQueryData<PaneListResponse>(['terminal-detached-panes'])
          ?.items,
      ).toEqual([detachedPane])
      expect(
        queryClient
          .getQueryData<Array<{ id: string }>>(['terminal-sessions', true])
          ?.map((session) => session.id),
      ).toEqual(['session-a'])
    })
  })

  it('stays failed, not loading, while a list that never loaded is refetched', async () => {
    serve('GET /api/panes', () => Promise.reject(new Error('down')))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { result } = renderHook(
      () => ({ panes: useTerminalPanes(), list: usePaneListError() }),
      { wrapper: createWrapper(queryClient) },
    )

    await waitFor(() => expect(result.current.list.isError).toBe(true))
    expect(result.current.panes.isLoading).toBe(false)
    expect(result.current.panes.loadFailed).toBe(true)

    serve('GET /api/panes', () => new Promise(() => {}))
    act(() => result.current.list.retry())
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: ['terminal-panes'] })).toBe(1),
    )
    expect(result.current.list.isError).toBe(true)
    expect(result.current.panes.isLoading).toBe(false)
  })
})
