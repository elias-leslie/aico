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
      contextTokens: null,
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
function show(fetcher: typeof fetch, tab = 'Cost') {
  vi.stubGlobal('fetch', fetcher)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const shown = render(
    <QueryClientProvider client={client}>
      <ContextPage memory={<p>The memory list</p>} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: tab }))
  return shown
}
it('is called Context, opens on Prompts, and has Roles, Memory and Cost', async () => {
  show(
    vi.fn(async () => Response.json(view)),
    'Prompts',
  )
  expect(
    screen.getByRole('heading', { level: 2, name: 'Context' }),
  ).toBeInTheDocument()
  expect(
    screen
      .getAllByRole('button', { pressed: false })
      .concat(screen.getAllByRole('button', { pressed: true }))
      .map((b) => b.textContent),
  ).toEqual(expect.arrayContaining(['Prompts', 'Roles', 'Memory', 'Cost']))
  // A prompt opens in place from its row.
  expect(screen.queryByLabelText('Prompt text')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: /Project guide/ }))
  expect(screen.getByLabelText('Prompt text')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
  expect(screen.getByText('The memory list')).toBeInTheDocument()
  expect(screen.queryByLabelText('Prompt text')).toBeNull()
})
afterEach(() => vi.unstubAllGlobals())
it('shows a partial start, unknown use and no limit without inventing zeros', async () => {
  show(vi.fn(async () => Response.json(view)))
  expect(screen.getByRole('status')).toHaveTextContent('Loading')
  // Nothing is known about use: said once, not as a badge on every row.
  expect(
    await screen.findByText(
      'Use isn’t known yet: 0 of 3 full sessions read so far.',
    ),
  ).toBeInTheDocument()
  expect(screen.queryByText('Usage unknown')).toBeNull()
  expect(screen.getByText('No size limit set')).toBeInTheDocument()
  expect(screen.getByText(/Part of it didn’t load/)).toHaveTextContent(
    '1 item is missing (Unavailable)',
  )
  expect(screen.getByText(/Part of it didn’t load/)).not.toHaveTextContent(
    'tool-usage',
  )
  expect(screen.getByText('Conversation size not read yet')).toBeInTheDocument()
  expect(screen.queryByText(/prompt:guide|UTF-8/)).toBeNull()
  expect(screen.getByText('Prompt · ~100 tokens')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(
    screen.getByText('No items qualify for this view.'),
  ).toBeInTheDocument()
})
it('says nothing was loaded for a start with no items, not a size of zero', async () => {
  const empty = {
    ...view,
    deliveries: [
      {
        ...view.deliveries[0]!,
        tokens: 0,
        items: [],
        missing: [],
        observed: false,
      },
    ],
  }
  show(vi.fn(async () => Response.json(empty)))
  expect(await screen.findByText('Nothing loaded at start')).toBeInTheDocument()
  expect(screen.queryByText(/~0 tokens/)).toBeNull()
  expect(
    screen.getByRole('option', { name: /nothing loaded/ }),
  ).toBeInTheDocument()
})
it('shows the context in use when the provider counted it', async () => {
  const counted = {
    ...view,
    deliveries: [{ ...view.deliveries[0]!, contextTokens: 41_250 }],
  }
  show(vi.fn(async () => Response.json(counted)))
  expect(
    await screen.findByText(
      '41,250 tokens in the conversation at its last reply',
    ),
  ).toBeInTheDocument()
})
it('labels the size limit and explains a badge when some use is known', async () => {
  const mixed = {
    ...view,
    deliveries: [
      {
        ...view.deliveries[0]!,
        budget: 60_000,
        items: [
          { ...view.deliveries[0]!.items[0]!, use: 'used' as const },
          {
            ...view.deliveries[0]!.items[0]!,
            id: 'memory:a',
            title: 'A memory',
            type: 'memory',
            observedSessions: 2,
          },
        ],
      },
    ],
  }
  show(vi.fn(async () => Response.json(mixed)))
  expect(
    await screen.findByText('Size limit 60,000 tokens'),
  ).toBeInTheDocument()
  expect(screen.getByText('Use recorded')).toBeInTheDocument()
  expect(screen.getByText('Usage unknown')).toHaveAttribute(
    'title',
    'Read in 2 of the 3 full sessions needed to say.',
  )
})
it("shows a live session's context in use from its history", async () => {
  show(
    vi.fn(async (input) =>
      String(input).startsWith('/api/history')
        ? Response.json({
            items: [
              { tool: 'codex', startedAt: 1, contextTokens: 5 },
              { tool: 'codex', startedAt: 2, contextTokens: 88_000 },
            ],
          })
        : Response.json(view),
    ),
  )
  expect(
    await screen.findByText(
      '88,000 tokens in the conversation at its last reply',
    ),
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
  await screen.findByText(/Use isn’t known yet/)
  fireEvent.click(screen.getByRole('button', { name: 'Prompts' }))
  fireEvent.click(screen.getByRole('button', { name: /Project guide/ }))
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
  await screen.findByText(/Use isn’t known yet/)
  failed = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh context' }))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Showing the last read',
    ),
  )
  expect(screen.getByText(/Use isn’t known yet/)).toBeInTheDocument()
})
