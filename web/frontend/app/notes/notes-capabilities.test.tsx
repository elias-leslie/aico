import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotesPanel, NotesProvider } from '@summitflow/notes-ui'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function emptyResponse(status = 404): Response {
  return new Response('', { status })
}

function buildFetchMock(capabilities: {
  title_generation: boolean
  formatting: boolean
  prompt_refinement: boolean
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')

    if (url.pathname === '/api/notes/capabilities') {
      return jsonResponse(capabilities)
    }

    if (url.pathname === '/api/notes/scopes') {
      return jsonResponse([
        {
          value: 'global',
          label: 'Global',
          known: true,
        },
      ])
    }

    if (url.pathname === '/api/notes/tags') {
      return jsonResponse({ tags: [] })
    }

    if (url.pathname === '/api/notes') {
      if (url.searchParams.get('type') === 'prompt') {
        return jsonResponse({
          items: [
            {
              id: 'prompt-1',
              project_scope: 'global',
              type: 'prompt',
              title: 'Shared Prompt',
              content: 'Prompt content that stays under the note editor threshold.',
              tags: [],
              pinned: false,
              metadata: {},
              created_at: '2026-04-09T00:00:00Z',
              updated_at: '2026-04-09T00:00:00Z',
            },
          ],
          total: 1,
        })
      }

      return jsonResponse({ items: [], total: 0 })
    }

    if (url.pathname === '/api/notes/prompt-1/format-proposal') {
      return emptyResponse()
    }

    throw new Error(`Unhandled fetch: ${url.pathname}${url.search}`)
  })
}

function renderNotesPanel(capabilities: {
  title_generation: boolean
  formatting: boolean
  prompt_refinement: boolean
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  })

  const fetchMock = buildFetchMock(capabilities)
  vi.stubGlobal('fetch', fetchMock)

  render(
    <QueryClientProvider client={queryClient}>
      <NotesProvider apiPrefix="/api" projectScope="global">
        <NotesPanel />
      </NotesProvider>
    </QueryClientProvider>,
  )
}

async function openPromptEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Prompts' }))

  const promptButton = await screen.findByRole('button', {
    name: /Shared Prompt/i,
  })
  fireEvent.click(promptButton)
}

describe('Notes capability-aware UI state', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps companion-only prompt actions hidden in standalone capability mode', async () => {
    renderNotesPanel({
      title_generation: true,
      formatting: false,
      prompt_refinement: false,
    })

    await openPromptEditor()

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText(/Refine this prompt/i),
      ).not.toBeInTheDocument()
    })
    expect(
      screen.queryByTitle(/Format note \(title \+ content cleanup\)/i),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })

  it('shows refinement and formatting controls when companion capabilities are available', async () => {
    renderNotesPanel({
      title_generation: true,
      formatting: true,
      prompt_refinement: true,
    })

    await openPromptEditor()

    expect(
      await screen.findByPlaceholderText(/Refine this prompt/i),
    ).toBeInTheDocument()
    expect(
      screen.getByTitle(/Format note \(title \+ content cleanup\)/i),
    ).toBeInTheDocument()
  })
})
