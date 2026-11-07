import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryPage } from './HistoryPage'

const api = vi.hoisted(() => ({
  list: null as unknown,
  detail: null as unknown,
  events: {} as Record<string, unknown>,
  calls: [] as string[],
  live: { items: [] } as unknown,
  sessions: { items: [] } as unknown,
}))
vi.mock('@/lib/api-fetch', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/api-fetch')>('@/lib/api-fetch')
  const { ApiError } = actual
  return {
    ...actual,
    apiFetch: vi.fn(async (url: string) => {
      api.calls.push(url)
      if (url === '/api/history/live') return api.live
      if (url.startsWith('/api/sessions')) return api.sessions
      if (url.startsWith('/api/history?')) {
        if (!api.list) throw new ApiError('Tether is not reachable', 503)
        return api.list
      }
      if (url.includes('/events?')) {
        const answer = api.events[url.includes('before=') ? 'older' : 'newest']
        if (answer instanceof Error) throw answer
        return answer
      }
      if (url.startsWith('/api/history/')) {
        if (api.detail instanceof Error) throw api.detail
        return api.detail
      }
      throw new Error(`unexpected ${url}`)
    }),
  }
})
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const session = (over: object = {}) => ({
  id: 'codex:abc',
  tool: 'codex',
  parentId: null,
  project: 'demo',
  cwd: '/work/demo',
  model: 'codex-test',
  startedAt: Date.now() - 600_000,
  endedAt: Date.now() - 300_000,
  outcome: 'completed',
  tokens: { input: 200, cacheRead: 12_000, cacheWrite: 0, output: 20 },
  toolCalls: 3,
  filesWritten: 2,
  ...over,
})

const renderPage = (id = '') => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <HistoryPage session={id} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  api.list = null
  api.detail = null
  api.events = {}
  api.calls = []
  api.live = { items: [] }
  api.sessions = { items: [] }
})

describe('recent sessions list', () => {
  it('shows each session with its state, tokens and a link to the transcript', async () => {
    api.list = {
      items: [
        session(),
        session({ id: 'pi:x', tool: 'pi', outcome: 'error', project: null }),
      ],
    }
    renderPage()
    expect(screen.getByText('Loading recent sessions…')).toBeTruthy()
    await screen.findAllByText(/demo/)
    expect(screen.getByText('Finished')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getAllByText(/200 in · 12k cached · 20 out/)).toHaveLength(4)
    const link = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.includes('codex%3Aabc'))
    expect(link?.getAttribute('href')).toBe('/history?session=codex%3Aabc')
  })

  it('says plainly when there are none, and when the load failed', async () => {
    api.list = { items: [] }
    const { unmount } = renderPage()
    await screen.findByText('No sessions yet')
    unmount()
    api.list = null
    renderPage()
    await screen.findByText(
      'Couldn’t load recent sessions.',
      {},
      { timeout: 3000 },
    )
    expect(screen.getByText('No sessions to show')).toBeTruthy()
    expect(screen.queryByText('No sessions yet')).toBeNull()
  })

  it('asks for one tool when it is picked', async () => {
    api.list = { items: [session()] }
    renderPage()
    await screen.findAllByText(/demo/)
    fireEvent.change(screen.getByLabelText('Tool'), { target: { value: 'pi' } })
    await waitFor(() =>
      expect(api.calls.some((c) => c.includes('tool=pi'))).toBe(true),
    )
  })
})

describe('Recent and the running sessions', () => {
  it('never lists a conversation a running session still owns as Finished', async () => {
    api.list = {
      items: [
        session({ id: 'codex:live', project: 'coordinator' }),
        session({ id: 'codex:done', project: 'old job' }),
      ],
    }
    api.sessions = { items: [{ id: 'abcd1234', name: 'Coordinator lane' }] }
    api.live = {
      items: [
        {
          session: 'abcd1234',
          conversation: 'codex:live',
          activity: 'working',
          lastWriteAt: Date.now(),
        },
      ],
    }
    renderPage()
    await screen.findByText('Coordinator lane')
    await waitFor(() => expect(screen.getByText('Working')).toBeTruthy())
    expect(screen.getAllByText('Finished')).toHaveLength(1)
  })

  it('leaves smoke and scratch runs out until asked, and says how many are hidden', async () => {
    api.list = {
      items: [
        session({ id: 'codex:real', project: 'aico' }),
        session({ id: 'codex:t1', project: 'aico-m10d2-live', test: true }),
        session({ id: 'codex:t2', project: 'commit-try', test: true }),
      ],
    }
    renderPage()
    await screen.findAllByText(/aico/)
    expect(screen.queryByText(/commit-try/)).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: '2 test runs hidden · Show' }),
    )
    expect(screen.getByText(/commit-try/)).toBeTruthy()
    expect(screen.getByText(/aico-m10d2-live/)).toBeTruthy()
  })
})

describe('row names', () => {
  it('names a row by its running session, else by the tool and start time, with the project beside it', async () => {
    api.list = {
      items: [
        session({ id: 'codex:a', project: 'aico' }),
        session({ id: 'codex:b', project: 'aico' }),
      ],
    }
    api.sessions = { items: [{ id: 'abcd1234', name: 'Fix quota' }] }
    api.live = {
      items: [
        {
          session: 'abcd1234',
          conversation: 'codex:a',
          activity: 'idle',
          lastWriteAt: Date.now(),
        },
      ],
    }
    renderPage()
    expect(await screen.findByText('Fix quota')).toBeTruthy()
    expect(screen.getByText(/^Codex · /)).toBeTruthy()
    expect(screen.queryByText('aico')).toBeNull()
  })

  it('lists only failed sessions when asked', async () => {
    api.list = {
      items: [
        session({ id: 'codex:ok' }),
        session({
          id: 'codex:bad',
          outcome: 'error',
          project: 'broke',
          cwd: '/work/broke',
        }),
      ],
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <HistoryPage failedOnly />
      </QueryClientProvider>,
    )
    expect(await screen.findAllByText(/broke/)).not.toHaveLength(0)
    expect(screen.queryByText(/demo/)).toBeNull()
    expect(screen.getByText('Failed')).toBeTruthy()
  })
})

describe('transcript', () => {
  it('leads with the session’s final reply, formatted', async () => {
    api.detail = {
      ...session(),
      path: '/x',
      files: [],
      subagents: {
        count: 0,
        toolCalls: 0,
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      },
    }
    api.events = {
      newest: {
        items: [
          { offset: 1, at: null, role: 'user', kind: 'text', text: 'go' },
          {
            offset: 2,
            at: null,
            role: 'assistant',
            kind: 'text',
            text: 'All **done**.',
          },
        ],
        older: null,
        newer: null,
        size: 3,
      },
    }
    renderPage('codex:abc')
    const final = await screen.findByTestId('history-final')
    expect(final).toHaveTextContent('Final reply')
    expect(final.querySelector('strong')?.textContent).toBe('done')
    // The same message in the transcript below shows no markup characters.
    const transcript = screen.getByRole('region', { name: 'Transcript' })
    expect(transcript.querySelector('strong')?.textContent).toBe('done')
    expect(transcript).not.toHaveTextContent('**')
  })

  const detail = () => ({
    ...session(),
    path: '/x',
    files: [{ path: '/work/demo/a.txt', writes: 2 }],
    subagents: {
      count: 0,
      toolCalls: 0,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
  })

  it('shows the totals and the messages, with older ones on request', async () => {
    api.detail = detail()
    api.events = {
      newest: {
        items: [
          {
            offset: 10,
            at: null,
            role: 'user',
            kind: 'text',
            text: 'make a file',
          },
          {
            offset: 20,
            at: null,
            role: 'assistant',
            kind: 'tool_call',
            text: 'echo hi',
            tool: 'exec',
          },
          {
            offset: 30,
            at: null,
            role: 'tool',
            kind: 'tool_result',
            text: 'hi',
          },
        ],
        older: 10,
        newer: null,
        size: 40,
      },
      older: {
        items: [
          {
            offset: 0,
            at: null,
            role: 'assistant',
            kind: 'text',
            text: 'earlier reply',
          },
        ],
        older: null,
        newer: null,
        size: 40,
      },
    }
    renderPage('codex:abc')
    await screen.findByText('make a file')
    expect(screen.getByTestId('history-facts').textContent).toContain(
      '3 tool calls · 1 file written',
    )
    expect(screen.getByText('echo hi')).toBeTruthy()
    fireEvent.click(screen.getByText('Show older messages'))
    await screen.findByText('earlier reply')
    expect(screen.queryByText('Show older messages')).toBeNull()
  })

  it('keeps the totals and explains a removed transcript', async () => {
    const { ApiError } = await import('@/lib/api-fetch')
    api.detail = detail()
    api.events = { newest: new ApiError('gone', 410) }
    renderPage('codex:abc')
    await screen.findByText(/removed this transcript/)
    expect(screen.getByTestId('history-facts')).toBeTruthy()
  })

  it('says when the session is not listed any more', async () => {
    const { ApiError } = await import('@/lib/api-fetch')
    api.detail = new ApiError('No session with that id', 404)
    api.events = { newest: new ApiError('No session with that id', 404) }
    renderPage('codex:zzz')
    await waitFor(() =>
      expect(
        screen.getAllByText(/no longer in the list/).length,
      ).toBeGreaterThan(0),
    )
  })
})
