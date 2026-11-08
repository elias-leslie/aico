import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useShareList } from './use-agent-shows'

const share = {
  id: 'ab12cd34ef56',
  session: 'ab12cd34',
  title: 'Report',
  createdAt: '2026-10-27T10:00:00.000Z',
  kind: 'files',
  paths: ['/srv/out/report.md'],
}

function listed(...shows: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ shows }))),
  )
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  )
  return renderHook(() => useShareList(), { wrapper })
}

describe('useShareList', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('lists what the server lists', async () => {
    const { result } = listed(share)
    await waitFor(() => expect(result.current.data).toEqual([share]))
  })

  it('refuses shares that are not what the server sends', async () => {
    const { result } = listed({ ...share, id: 'nope' })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
