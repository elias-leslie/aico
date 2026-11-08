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
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
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

  it("folds a grant's heartbeat uses into its history row and lists no raw uses", async () => {
    const id = 'c'.repeat(32)
    api.view = view({
      requests: [request(id, 'expired', nowS - 600)],
      uses: [
        {
          at: nowS - 3000,
          event: 'approved',
          id,
          kind: 'owner-chrome',
          uid: 1,
        },
        ...Array.from({ length: 40 }, (_, i) => ({
          at: nowS - 2900 + i * 30,
          event: 'use',
          id,
          kind: 'owner-chrome',
          uid: 1,
        })),
      ],
    })
    const { container } = renderPage()
    const history = await screen.findByRole('region', { name: /History/ })
    fireEvent.click(
      within(history).getByRole('button', { name: /Your main Chrome/ }),
    )
    expect(within(history).getByText(/\(40 checks\)/)).toBeInTheDocument()
    expect(screen.queryByText(/Recent use/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
    expect(container.querySelector('.lantern-btn.ghost')).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveClass(
      'lantern-btn',
    )
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
      await screen.findByText(/A request shows up here/),
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
    expect(screen.queryByText(/A request shows up here/)).toBeNull()
  })

  it('says it is loading before the answer', () => {
    api.view = view()
    renderPage()
    expect(screen.getByRole('status')).toHaveTextContent('Loading grants…')
  })
})
