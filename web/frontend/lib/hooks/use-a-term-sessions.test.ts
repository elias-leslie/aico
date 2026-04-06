import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useATermSessions } from './use-a-term-sessions'

// Mock the api-config module
vi.mock('../api-config', () => ({
  buildApiUrl: (path: string) => `http://localhost:8002${path}`,
}))

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
    name: 'A-Term 1',
    user_id: null,
    project_id: 'proj-1',
    working_dir: '/home/user',
    mode: 'shell',
    display_order: 0,
    is_alive: true,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'session-2',
    name: 'A-Term 2',
    user_id: null,
    project_id: null,
    working_dir: '/tmp',
    mode: 'shell',
    display_order: 1,
    is_alive: true,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
  },
]

describe('useATermSessions', () => {
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

    const { result } = renderHook(() => useATermSessions(), {
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
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8002/api/a-term/sessions',
      undefined,
    )
  })

  it('handles API errors gracefully', async () => {
    const errorBody = JSON.stringify({ detail: 'Server error' })
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => errorBody,
      json: async () => JSON.parse(errorBody),
    })

    const { result } = renderHook(() => useATermSessions(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    expect(result.current.error).toBeDefined()
  })
})
