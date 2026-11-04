import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatView } from '@/lib/chat'
import { ChatSession } from './ChatSession'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
class Stream {
  static current: Stream
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor() {
    Stream.current = this
  }
}
const view = (extra: Partial<ChatView> = {}): ChatView => ({
  id: '0123abcd',
  title: 'Check the note merge',
  role: 'implementation',
  cwd: '/scratch/chat',
  state: 'idle',
  updatedAt: 1000,
  startedAt: 1000,
  model: 'first',
  nextModel: 'first',
  firstModel: 'first',
  last: 'Answer',
  draft: '',
  queued: [],
  note: null,
  effort: null,
  partial: null,
  parent: null,
  branchTurn: null,
  questions: [],
  chain: [
    { id: 'first', effort: 'high' },
    { id: 'second', effort: 'high' },
  ],
  handoffs: [],
  tools: [],
  totals: {
    startedAt: 1000,
    tokens: { input: 12, cacheRead: 3, cacheWrite: 0, output: 4 },
    toolCalls: 0,
  },
  outcome: null,
  messages: [
    {
      seq: 0,
      role: 'user',
      model: null,
      turn: 1,
      at: new Date(1000).toISOString(),
      stop_reason: null,
      content: [{ type: 'text', text: 'First question' }],
      meta: {},
      outcome: null,
      input: null,
      cache_read: null,
      cache_write: null,
      output: null,
    },
    {
      seq: 1,
      role: 'assistant',
      model: 'first',
      turn: 1,
      at: new Date(2000).toISOString(),
      stop_reason: 'stop',
      content: [{ type: 'text', text: 'Answer with `code`.' }],
      meta: {},
      outcome: null,
      input: 12,
      cache_read: 3,
      cache_write: 0,
      output: 4,
    },
  ],
  ...extra,
})
function show(chat: ChatView) {
  vi.stubGlobal('EventSource', Stream)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    value: vi.fn(),
    configurable: true,
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(['aico-chat', chat.id], chat)
  const fetcher = vi.fn(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify(chat), {
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  render(
    <QueryClientProvider client={client}>
      <ChatSession id={chat.id} />
    </QueryClientProvider>,
  )
  return { client, fetcher }
}
afterEach(() => {
  vi.unstubAllGlobals()
})
describe('desktop chat', () => {
  it('shows models and turns, opens Details and a branch dialog without replacing this chat', () => {
    show(view())
    expect(screen.getByText('Turn 1 ·', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent(
      'first, role’s first choice',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Details: tokens, models, run' }),
    )
    expect(screen.getByLabelText('Chat details')).toHaveTextContent(
      'From cache3',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Branch from here' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'This chat stays as it is.',
    )
  })
  it('shows the active model while working and keeps inherited usage out of branch totals', () => {
    const chat = view({
      state: 'working',
      model: 'second',
      nextModel: 'first',
      partial: { text: 'Writing', model: 'second', turn: 2 },
      parent: 'source',
      branchTurn: 1,
      totals: {
        startedAt: 1000,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCalls: 0,
      },
    })
    show(chat)
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue(
      'second',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Details: tokens, models, run' }),
    )
    expect(screen.getByLabelText('Chat details')).not.toHaveTextContent('12 in')
  })
  it('keeps stale questions separate from a disconnected conversation', () => {
    show(view({ questionsStatus: 'stale' }))
    expect(screen.getByText(/Questions may be out of date/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })
  it('keeps Idle quiet and only shows the answer card for an explicit question', async () => {
    const { client } = show(view())
    expect(screen.getByText('Idle', { exact: true })).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Question from this chat' }),
    ).toBeNull()
    act(() =>
      client.setQueryData(
        ['aico-chat', '0123abcd'],
        view({
          state: 'needs-you',
          questions: [
            {
              id: 'ask',
              question: 'Keep it?',
              options: ['Keep', 'Replace'],
              recommended: 0,
              body: null,
            },
          ],
        }),
      ),
    )
    expect(
      await screen.findByRole('button', { name: 'Keep (recommended)' }),
    ).toBeInTheDocument()
  })
  it('queues a message without disabled model/effort preferences after an effort choice', async () => {
    const { client, fetcher } = show(view())
    fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), {
      target: { value: 'high' },
    })
    act(() =>
      client.setQueryData(
        ['aico-chat', '0123abcd'],
        view({ state: 'working' }),
      ),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Next message' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    const request = fetcher.mock.calls.find((args) =>
      String(args[0]).endsWith('/send'),
    )
    expect(JSON.parse(String((request?.[1] as RequestInit)?.body))).toEqual({
      message: 'Next message',
    })
  })
  it.each([
    ['stopped', 'Finish the reply'],
    ['failed', 'Try again'],
    ['swapped', 'Finish the reply'],
  ] as const)('offers recovery for %s', (state, action) => {
    show(view({ state }))
    expect(screen.getByRole('button', { name: action })).toBeInTheDocument()
    if (state === 'failed')
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Your message is kept',
      )
  })
  it('keeps received text when disconnected and offers Reconnect', () => {
    show(view())
    act(() => Stream.current.onerror?.())
    expect(
      screen.getByText('Answer with', { exact: false }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Reconnect' }),
    ).toBeInTheDocument()
  })
})
