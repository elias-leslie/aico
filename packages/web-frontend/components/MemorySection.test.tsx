import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemorySection } from './MemorySection'

const memory = (id: string, summary: string, tier = 'reference') => ({
  id,
  scope: 'global',
  scopeId: '',
  tier,
  summary,
  content: `${summary} in full.`,
  tags: ['one'],
  updatedAt: '2026-11-06T12:00:00Z',
})
function show(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', fetcher)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemorySection />
    </QueryClientProvider>,
  )
}
afterEach(() => vi.unstubAllGlobals())

it('shows loading, then the memories with kind and scope', async () => {
  show(
    vi.fn(async () =>
      Response.json({
        memories: [memory('a1', 'Use checks', 'mandate')],
        next: null,
      }),
    ),
  )
  expect(screen.getByRole('status')).toHaveTextContent('Loading memories')
  expect(await screen.findByText('Use checks')).toBeInTheDocument()
  expect(screen.getByText('Mandate · All sessions')).toBeInTheDocument()
})

it('says nothing saved versus nothing matching, and a failed load is not empty', async () => {
  const empty = vi.fn(async () => Response.json({ memories: [], next: null }))
  const first = show(empty)
  expect(await screen.findByText('No memories saved yet.')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Kind'), {
    target: { value: 'archive' },
  })
  expect(await screen.findByText(/No memories match/)).toBeInTheDocument()
  first.unmount()
  show(vi.fn(async () => Response.json({ detail: 'down' }, { status: 500 })))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not load memories.',
  )
  expect(screen.queryByText('No memories saved yet.')).toBeNull()
})

it('searches after typing', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json({ memories: [], next: null }),
  )
  show(fetcher as unknown as typeof fetch)
  await screen.findByText('No memories saved yet.')
  fireEvent.change(screen.getByLabelText('Search'), {
    target: { value: 'zebra' },
  })
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes('q=zebra')),
    ).toBe(true),
  )
})

it('deletes only after confirming, and shows a failed delete', async () => {
  let deleted = false
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      if (
        !deleted &&
        fetcher.mock.calls.filter(([, i]) => i?.method === 'DELETE').length ===
          1
      )
        return Response.json({ detail: 'Nope' }, { status: 500 })
      deleted = true
      return Response.json({ deleted: true })
    }
    return Response.json({
      memories: deleted ? [] : [memory('a1', 'Use checks')],
      next: null,
    })
  })
  show(fetcher as unknown as typeof fetch)
  fireEvent.click(await screen.findByRole('button', { name: /Use checks/ }))
  fireEvent.click(
    screen.getByRole('button', { name: /Delete memory: Use checks/ }),
  )
  expect(fetcher.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false)
  fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
  expect(await screen.findByText(/Could not delete: Nope/)).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
  expect(await screen.findByText('No memories saved yet.')).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledWith('/api/memories/a1', { method: 'DELETE' })
})

it('shows a memory written in markdown as formatted text', async () => {
  show(
    vi.fn(async () =>
      Response.json({
        memories: [
          {
            ...memory('m1', 'Scrollback logging'),
            content:
              '**Scrollback**: use `debug` level.\n\n- first\n- *second*',
          },
        ],
        next: null,
      }),
    ),
  )
  fireEvent.click(
    await screen.findByRole('button', { name: /Scrollback logging/ }),
  )
  const bold = await screen.findByText('Scrollback', { selector: 'strong' })
  expect(bold).toBeInTheDocument()
  expect(screen.getByText('debug', { selector: 'code' })).toBeInTheDocument()
  expect(screen.getByText('second', { selector: 'em' })).toBeInTheDocument()
  expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2)
  expect(document.body.textContent).not.toContain('**')
})
