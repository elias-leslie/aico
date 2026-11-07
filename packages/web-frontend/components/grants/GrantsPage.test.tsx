import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrantsView } from '@/lib/grants'
import { GrantsPage } from './GrantsPage'

const api = vi.hoisted(() => ({
  view: null as unknown,
  fail: false,
  calls: [] as { url: string; method: string }[],
}))
vi.mock('@/lib/api-fetch', () => ({
  apiFetch: vi.fn(async (url: string, options?: RequestInit) => {
    api.calls.push({ url, method: options?.method ?? 'GET' })
    if (url === '/api/grants') {
      if (api.fail) throw new Error('Couldn’t read grants')
      return api.view
    }
    return {}
  }),
}))

const nowS = Date.now() / 1000
const view = (over: Partial<GrantsView> = {}): GrantsView => ({
  requests: [],
  uses: [],
  labels: { 'owner-chrome': 'your main Chrome' },
  ...over,
})
const request = (id: string, state: string, expires: number) => ({
  id,
  title: 'Open your main Chrome for 15 min?',
  reason: 'Why',
  agent: 'aico',
  state,
  expires,
})

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <GrantsPage />
    </QueryClientProvider>,
  )
}

describe('GrantsPage', () => {
  beforeEach(() => {
    api.fail = false
    api.calls = []
  })

  it('splits Active and History and never asks for a tap on an expired request', async () => {
    api.view = view({
      requests: [
        request('a'.repeat(32), 'pending', nowS + 600),
        request('b'.repeat(32), 'pending', nowS - 600),
        request('c'.repeat(32), 'expired', nowS - 7200),
      ],
    })
    renderPage()
    const active = await screen.findByRole('region', { name: /Active/ })
    const history = screen.getByRole('region', { name: /History/ })
    expect(within(active).getByText('Waiting')).toBeInTheDocument()
    expect(within(active).getAllByRole('listitem')).toHaveLength(1)
    expect(within(history).getAllByText('Expired')).toHaveLength(2)
    expect(within(history).queryByText(/Needs your tap|Waiting/)).toBeNull()
    expect(screen.getByText(/Nightshift or Aico tray/)).toBeInTheDocument()
  })

  it('withdraws a waiting request', async () => {
    api.view = view({
      requests: [request('a'.repeat(32), 'pending', nowS + 600)],
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }))
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        url: '/api/grants/revoke',
        method: 'POST',
      }),
    )
  })

  it('gives each section its own empty copy', async () => {
    api.view = view()
    renderPage()
    expect(
      await screen.findByText(/Nothing is open or waiting/),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Nothing has expired or ended yet.'),
    ).toBeInTheDocument()
  })

  it('says a failed load failed, not that there are none', async () => {
    api.fail = true
    renderPage()
    expect(
      await screen.findByText('Couldn’t read grants.', {}, { timeout: 4000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Nothing is open or waiting/)).toBeNull()
  })

  it('says it is loading before the answer', () => {
    api.view = view()
    renderPage()
    expect(screen.getByRole('status')).toHaveTextContent('Loading grants…')
  })
})
