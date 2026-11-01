// The open session's own question: only that session's, open while the agent
// waits, folded otherwise, answered in place on a desktop and handed to the
// Needs you sheet on the phone.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerAsk } from '@/lib/hooks/use-asks'
import { closeNeedsYou, useNeedsYouState } from './NeedsYou'
import { SessionAsk } from './SessionAsk'

const state = vi.hoisted(() => ({
  asks: [] as OwnerAsk[],
  phone: false,
  sent: [] as unknown[],
}))
vi.mock('@/lib/hooks/use-asks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/use-asks')>()),
  useOwnerAsks: () => ({
    asks: state.asks,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  useApprovals: () => ({ approvals: { state: 'ok', taps: [] } }),
  useAskReply: () => ({
    mutate: (value: unknown) => state.sent.push(value),
    mutateAsync: async (value: { id: string }) => {
      state.sent.push(value)
      const saved = state.asks.find((item) => item.id === value.id)
      return { ask: { ...saved, state: 'answered', delivery: 'wake' } }
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}))
vi.mock('@/lib/hooks/use-terminal-sessions', () => ({
  SESSION_REFRESH_MS: 5_000,
  useTerminalSessions: () => ({
    sessions: [{ id: '0123abcd', name: 'Disk merge' }],
  }),
}))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => state.phone,
}))
vi.mock('@/lib/files-opener', () => ({ openFiles: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const NOW = Date.now()
const ask = (patch: Partial<OwnerAsk> = {}): OwnerAsk => ({
  id: 'abcdefabcdef',
  session: '0123abcd',
  requester: null,
  question: 'Finish the single Linux partition?',
  options: ['Finish it now', 'Stop here'],
  recommended: 0,
  body: null,
  command: null,
  share: null,
  blocking: true,
  state: 'open',
  answer: null,
  note: null,
  delivery: null,
  createdAt: NOW - 120_000,
  updatedAt: NOW - 120_000,
  answeredAt: null,
  ...patch,
})

beforeEach(() => {
  state.asks = []
  state.phone = false
  state.sent = []
  act(() => closeNeedsYou())
})

describe('SessionAsk', () => {
  it('shows nothing for another session’s question', () => {
    state.asks = [ask({ session: '99999999' })]
    render(<SessionAsk sessionId="0123abcd-full-id" />)
    expect(screen.queryByTestId('session-ask')).toBeNull()
  })

  it('opens while the agent waits and answers in place', async () => {
    state.asks = [ask(), ask({ id: '222222222222', session: '55555555' })]
    const { rerender } = render(<SessionAsk sessionId="0123abcd-full-id" />)
    const strip = screen.getByTestId('session-ask')
    const head = within(strip).getByRole('button', { expanded: true })
    expect(head).toHaveTextContent('Waiting on you')
    expect(
      within(strip).getByRole('button', { name: 'See all 2' }),
    ).toBeVisible()
    const card = within(strip).getByTestId('ask-card')
    expect(within(card).queryByText('Disk merge')).toBeNull()
    expect(
      within(card).queryByRole('button', { name: 'Open session' }),
    ).toBeNull()
    fireEvent.click(within(card).getAllByRole('radio')[0] as HTMLElement)
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }))
    expect(state.sent).toEqual([
      { id: 'abcdefabcdef', reply: { kind: 'answer', option: 0 } },
    ])
    // The question leaves; the line says where the answer went.
    await act(async () => {})
    state.asks = [{ ...ask(), state: 'answered' }]
    rerender(<SessionAsk sessionId="0123abcd-full-id" />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sent to “Disk merge”: Finish it now.',
    )
  })

  it('stays one folded line for a whenever question until opened', () => {
    state.asks = [ask({ blocking: false })]
    render(<SessionAsk sessionId="0123abcd" />)
    const head = screen.getByRole('button', { expanded: false })
    expect(head).toHaveTextContent(
      'Asked you· 2mFinish the single Linux partition?',
    )
    expect(screen.queryByTestId('ask-card')).toBeNull()
    fireEvent.click(head)
    expect(screen.getByTestId('ask-card')).toBeVisible()
  })

  it('hands the phone to the Needs you sheet on that question', () => {
    state.phone = true
    state.asks = [ask()]
    function Probe() {
      const { open, focus } = useNeedsYouState()
      return <p data-testid="probe">{open ? `open ${focus}` : 'closed'}</p>
    }
    render(
      <>
        <SessionAsk sessionId="0123abcd" />
        <Probe />
      </>,
    )
    expect(screen.queryByTestId('ask-card')).toBeNull()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Waiting on you: Finish the single Linux partition?. Answer',
      }),
    )
    expect(screen.getByTestId('probe')).toHaveTextContent('open abcdefabcdef')
    expect(screen.getByTestId('needs-you-drawer')).toBeInTheDocument()
  })
})
