import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROOT_CAN, TETHER_CAN } from '@/test-stubs/session-fixtures'
import { useTerminalSessions } from './use-terminal-sessions'

// Mock global fetch
const mockFetch = vi.fn()
global.fetch = mockFetch

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

const mockSessions = [
  {
    id: 'session-1',
    name: 'Session 1',
    user_id: null,
    project_id: 'proj-1',
    working_dir: '/home/user',
    mode: 'shell',
    display_order: 0,
    is_alive: true,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
    ...TETHER_CAN,
  },
  {
    id: 'session-2',
    name: 'Session 2',
    user_id: null,
    project_id: null,
    working_dir: '/tmp',
    mode: 'shell',
    display_order: 1,
    is_alive: true,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
    ...TETHER_CAN,
  },
]

describe('useTerminalSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists sessions from the API', async () => {
    const body = JSON.stringify({ items: mockSessions, total: 2 })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => body,
      json: async () => JSON.parse(body),
    })

    const { result } = renderHook(() => useTerminalSessions(), {
      wrapper: createWrapper(),
    })

    // Initially loading
    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.sessions).toHaveLength(2)
    expect(result.current.sessions[0].id).toBe('session-1')
    expect(result.current.sessions[1].id).toBe('session-2')

    // Verify fetch was called with the correct URL
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions', undefined)
  })

  it('handles API errors gracefully', async () => {
    const errorBody = JSON.stringify({ detail: 'Server error' })
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => errorBody,
      json: async () => JSON.parse(errorBody),
    })

    const { result } = renderHook(() => useTerminalSessions(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    expect(result.current.error).toBeDefined()
  })

  it('can include detached sessions for detached-pane windows', async () => {
    const body = JSON.stringify({ items: mockSessions, total: 2 })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => body,
      json: async () => JSON.parse(body),
    })

    const { result } = renderHook(
      () => useTerminalSessions({ includeDetached: true }),
      {
        wrapper: createWrapper(),
      },
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions?include_detached=true',
      undefined,
    )
  })

  it('invalidates attached and detached pane session names after a manual rename', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    queryClient.setQueryData(['terminal-sessions', false], mockSessions)
    queryClient.setQueryData(['terminal-panes'], { items: [] })
    queryClient.setQueryData(['terminal-detached-panes'], { items: [] })
    const renamed = {
      ...mockSessions[0],
      name: 'Project · Focus',
      source: 'tether',
      is_root: true,
      ...ROOT_CAN,
    }
    mockFetch.mockImplementation(async (_url, options) => ({
      ok: true,
      text: async () =>
        JSON.stringify(
          options?.method === 'PATCH'
            ? renamed
            : { items: [renamed], total: 1 },
        ),
    }))
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result } = renderHook(() => useTerminalSessions(), { wrapper })
    await act(async () => {
      await result.current.update('session-1', { name: renamed.name })
    })
    await waitFor(() =>
      expect(result.current.sessions[0].name).toBe(renamed.name),
    )
    expect(queryClient.getQueryState(['terminal-panes'])?.isInvalidated).toBe(
      true,
    )
    expect(
      queryClient.getQueryState(['terminal-detached-panes'])?.isInvalidated,
    ).toBe(true)
  })

  it('ends a session, keeping its check-ins only when asked', async () => {
    mockFetch.mockImplementation(
      async (_url: string, options?: RequestInit) => ({
        ok: true,
        text: async () =>
          JSON.stringify(
            options?.method === 'DELETE'
              ? { deleted: true, id: 'session-1' }
              : { items: mockSessions, total: 2 },
          ),
      }),
    )
    const { result } = renderHook(() => useTerminalSessions(), {
      wrapper: createWrapper(),
    })
    await act(async () => {
      await result.current.remove('session-1')
      await result.current.remove('session-2', { keepCheckIns: true })
    })
    const deletes = mockFetch.mock.calls
      .filter(([, options]) => options?.method === 'DELETE')
      .map(([url]) => url)
    expect(deletes).toEqual([
      '/api/sessions/session-1',
      '/api/sessions/session-2?keepWakes=true',
    ])
  })

  it('unlists an ended session at once, before the refetch', async () => {
    let release: () => void = () => {}
    let listed = 0
    mockFetch.mockImplementation(
      async (_url: string, options?: RequestInit) => {
        if (options?.method === 'DELETE')
          return {
            ok: true,
            text: async () => JSON.stringify({ deleted: true }),
          }
        // The first list answers at once; the refetch after the end hangs.
        if (listed++ > 0) await new Promise<void>((done) => (release = done))
        return {
          ok: true,
          text: async () => JSON.stringify({ items: mockSessions, total: 2 }),
        }
      },
    )
    const { result } = renderHook(() => useTerminalSessions(), {
      wrapper: createWrapper(),
    })
    await waitFor(() => expect(result.current.sessions).toHaveLength(2))

    await act(async () => {
      await result.current.remove('session-1')
    })

    await waitFor(() =>
      expect(result.current.sessions.map((session) => session.id)).toEqual([
        'session-2',
      ]),
    )
    release()
  })
})
