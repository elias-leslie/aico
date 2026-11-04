import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ContextView } from '@/lib/context'
import { ContextPage } from './ContextPage'

const view: ContextView = {
  at: '2026-11-04T12:00:00Z',
  recentDays: 7,
  minObservedSessions: 3,
  bytesPerToken: 4,
  roles: [
    {
      name: 'builder',
      label: 'Builder',
      description: 'Builds things',
      context: 'default',
      updatedAt: 'v1',
      prompts: [1],
    },
  ],
  prompts: [
    {
      id: 1,
      slug: 'guide',
      name: 'Project guide',
      description: '',
      content: 'Use checks.',
      contextPolicy: { scope: 'global' },
      version: 1,
      updatedAt: 'v1',
    },
  ],
  deliveries: [
    {
      id: 1,
      at: '2026-11-04T12:00:00Z',
      tool: 'codex',
      role: 'builder',
      project: 'sample',
      session: 'one',
      tokens: 100,
      budget: null,
      observed: false,
      missing: [{ id: 'tool-usage', reason: 'Unavailable' }],
      items: [
        {
          id: 'prompt:guide',
          title: 'Project guide',
          type: 'prompt',
          tokens: 100,
          cut: false,
          use: 'unknown',
          observedSessions: 0,
        },
      ],
    },
  ],
}
function show(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', fetcher)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ContextPage />
    </QueryClientProvider>,
  )
}
afterEach(() => vi.unstubAllGlobals())
it('shows partial delivery, unknown use and no budget without inventing zeros', async () => {
  show(vi.fn(async () => Response.json(view)))
  expect(screen.getByRole('status')).toHaveTextContent('Loading')
  expect(await screen.findByText('Usage unknown')).toBeInTheDocument()
  expect(screen.getByText('No token budget set')).toBeInTheDocument()
  expect(screen.getByText(/Partial delivery/)).toHaveTextContent('Unavailable')
  fireEvent.click(screen.getByRole('checkbox'))
  expect(
    screen.getByText('No items qualify for this view.'),
  ).toBeInTheDocument()
})
it('keeps a draft when a stale save is refused', async () => {
  const calls: { url: string; body: unknown }[] = []
  show(
    vi.fn(async (input, options) => {
      if (options?.method === 'PUT') {
        calls.push({
          url: String(input),
          body: JSON.parse(String(options.body)),
        })
        return Response.json(
          { detail: 'This prompt changed. Reload before saving.' },
          { status: 409 },
        )
      }
      return Response.json(view)
    }),
  )
  await screen.findByText('Usage unknown')
  fireEvent.click(screen.getByRole('button', { name: 'Prompts' }))
  fireEvent.change(screen.getByLabelText('Prompt text'), {
    target: { value: 'My unsaved change.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('changed')
  expect(screen.getByLabelText('Prompt text')).toHaveValue('My unsaved change.')
  expect(calls[0]).toMatchObject({
    url: '/api/context/prompts/guide',
    body: { content: 'My unsaved change.', version: 1, updatedAt: 'v1' },
  })
})
it('keeps the last view visible when refresh fails', async () => {
  let failed = false
  show(
    vi.fn(async () =>
      failed
        ? Response.json({ detail: 'Unavailable' }, { status: 503 })
        : Response.json(view),
    ),
  )
  await screen.findByText('Usage unknown')
  failed = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh context' }))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Showing the last loaded view',
    ),
  )
  expect(screen.getByText('Usage unknown')).toBeInTheDocument()
})
