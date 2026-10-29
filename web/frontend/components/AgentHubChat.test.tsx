import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatInfo,
  ChatTransport,
} from '../../../electron/shared/chat/types'
import { AgentHubChat } from './AgentHubChat'

const seen: { info: ChatInfo; transport: ChatTransport }[] = []
vi.mock('../../../electron/shared/chat/chat-view', () => ({
  ChatRoot: (props: { info: ChatInfo; transport: ChatTransport }) => {
    seen.push(props)
    return <div data-testid="chat-root">{props.info.agentSlug}</div>
  },
}))

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function renderChat(source: Parameters<typeof AgentHubChat>[0]['source']) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AgentHubChat source={source} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  seen.length = 0
  vi.unstubAllGlobals()
})

describe('AgentHubChat', () => {
  it('says it is opening, then shows the chat of the session it asked for', async () => {
    const fetchMock = vi.fn(async () =>
      answer({
        ok: true,
        value: { sessionId: 'hub-1', agentSlug: 'coder', requestedModel: null },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderChat({ session: 'ab12cd34' })
    expect(screen.getByRole('status')).toHaveTextContent('Opening the chat')
    expect(await screen.findByTestId('chat-root')).toHaveTextContent('coder')
    expect(screen.getByTestId('agent-hub-chat')).not.toHaveAttribute(
      'data-readonly',
    )
  })

  it('shows a step with no message box and keeps it on the attempt it opened with', async () => {
    const fetchMock = vi.fn(async () =>
      answer({
        ok: true,
        value: {
          sessionId: 'att-2',
          agentSlug: 'pi',
          requestedModel: null,
          readOnly: true,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderChat({ run: 'r1', step: 'build' })
    await screen.findByTestId('chat-root')
    expect(screen.getByTestId('agent-hub-chat')).toHaveAttribute(
      'data-readonly',
      'true',
    )
    await seen.at(-1)?.transport.call('queue', { sessionId: 'att-2' })
    const [, init] = fetchMock.mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ]
    expect(JSON.parse(String(init.body))).toMatchObject({
      run: 'r1',
      step: 'build',
      attempt: 'att-2',
    })
  })

  it('does not rebuild the transport when the parent renders again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        answer({
          ok: true,
          value: {
            sessionId: 'hub-1',
            agentSlug: 'coder',
            requestedModel: null,
          },
        }),
      ),
    )
    const { rerender } = renderChat({ session: 'ab12cd34' })
    await screen.findByTestId('chat-root')
    const first = seen.at(-1)?.transport
    const client = new QueryClient()
    rerender(
      <QueryClientProvider client={client}>
        <AgentHubChat source={{ session: 'ab12cd34' }} />
      </QueryClientProvider>,
    )
    expect(seen.at(-1)?.transport).toBe(first)
  })

  it('says why it could not open and tries again on request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        answer(
          {
            ok: false,
            error: {
              code: 'agent_hub_unavailable',
              message: 'Agent Hub is not reachable.',
            },
          },
          503,
        ),
      )
      .mockResolvedValue(
        answer({
          ok: true,
          value: {
            sessionId: 'hub-1',
            agentSlug: 'coder',
            requestedModel: null,
          },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    renderChat({ session: 'ab12cd34' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Agent Hub is not reachable.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(screen.getByTestId('chat-root')).toBeInTheDocument(),
    )
  })
})
