import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCapture, uploadCapture } from '@/lib/api/captures'
import type { ChatView } from '@/lib/chat'
import { ChatSession } from './ChatSession'

vi.mock('@/lib/api/captures', async (original) => ({
  ...(await original<typeof import('@/lib/api/captures')>()),
  uploadCapture: vi.fn(),
  fetchCapture: vi.fn(),
}))

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
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
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
  it('restores the unsent text and file when a streamed attachment preparation fails', async () => {
    vi.mocked(fetchCapture).mockResolvedValue({
      id: '000000000003',
      name: 'photo.heic',
    } as Awaited<ReturnType<typeof fetchCapture>>)
    const chat = view({ id: 'recovery-test', state: 'working' })
    const { client } = show(chat)
    act(() =>
      client.setQueryData(['aico-chat', chat.id], {
        ...chat,
        state: 'failed',
        updatedAt: 3000,
        note: 'Files weren’t sent: This photo is still being prepared.',
        draft: 'Read this photo',
        draftAttachments: ['000000000003'],
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
        'Read this photo',
      ),
    )
    expect(
      await screen.findByRole('link', { name: 'photo.heic' }),
    ).toBeInTheDocument()
  })
  it('keeps a message unsent until its attachment is uploaded, then sends its capture ref', async () => {
    const { fetcher } = show(view())
    let finish: (value: Awaited<ReturnType<typeof uploadCapture>>) => void =
      () => {}
    vi.mocked(uploadCapture).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add photos or files' }))
    const picker =
      document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(picker).not.toBeNull()
    fireEvent.change(picker as HTMLInputElement, {
      target: {
        files: [new File(['log'], 'sync-log.txt', { type: 'text/plain' })],
      },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Read this log' },
    })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), {
      key: 'Enter',
    })
    expect(
      fetcher.mock.calls.some((args) => String(args[0]).endsWith('/send')),
    ).toBe(false)
    await act(async () =>
      finish({ id: '000000000001', name: 'sync-log.txt' } as Awaited<
        ReturnType<typeof uploadCapture>
      >),
    )
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some((args) => String(args[0]).endsWith('/send')),
      ).toBe(true),
    )
    const request = fetcher.mock.calls.find((args) =>
      String(args[0]).endsWith('/send'),
    )
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      message: 'Read this log',
      attachments: ['000000000001'],
    })
  })
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
  it('shows the saved effort and can explicitly return to routing', async () => {
    const { fetcher } = show(view({ effort: 'off' }))
    expect(screen.getByRole('combobox', { name: 'Effort' })).toHaveValue('off')
    fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Use routing' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    const request = fetcher.mock.calls.find((args) =>
      String(args[0]).endsWith('/send'),
    )
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      effort: null,
    })
  })
  it('keeps an explicit model visible until its first streaming update', async () => {
    const { fetcher } = show(view())
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify(view({ state: 'working' }))),
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'second' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Use the second model' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Stop' })
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue(
      'second',
    )
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
