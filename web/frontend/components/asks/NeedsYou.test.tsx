// The Needs you pill and drawer: the count, the recommendation marked, the
// answer sent as picked, approvals as links only, and an honest state for
// each of loading, empty and failed.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Approvals, OwnerAsk } from '@/lib/hooks/use-asks'
import { NeedsYouDrawer, NeedsYouLauncher } from './NeedsYou'

const state = vi.hoisted(() => ({
  asks: [] as OwnerAsk[],
  isLoading: false,
  isError: false,
  approvals: null as Approvals | null,
  approvalsLoading: false,
  sent: [] as unknown[],
}))
vi.mock('@/lib/hooks/use-asks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/use-asks')>()),
  useOwnerAsks: () => ({
    asks: state.asks,
    isLoading: state.isLoading,
    isError: state.isError,
    refetch: () => {},
  }),
  useApprovals: () => ({
    approvals: state.approvals,
    isLoading: state.approvalsLoading,
  }),
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
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => false }))
vi.mock('@/lib/files-opener', () => ({ openFiles: vi.fn() }))
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const NOW = Date.now()
const ask = (patch: Partial<OwnerAsk> = {}): OwnerAsk => ({
  id: 'abcdefabcdef',
  session: '0123abcd',
  requester: null,
  question: 'Finish the single Linux partition?',
  options: ['Finish it now', 'Stop here'],
  recommended: 0,
  body: 'Swap becomes a file.',
  command: 'sudo st disk merge --apply',
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
  state.isLoading = false
  state.isError = false
  state.approvals = { state: 'ok', taps: [] }
  state.approvalsLoading = false
  state.sent = []
  push.mockReset()
})

describe('NeedsYouLauncher', () => {
  it('counts open questions and approvals, not answered ones', () => {
    state.asks = [ask(), ask({ id: '111111111111', state: 'answered' })]
    state.approvals = {
      state: 'ok',
      taps: [
        {
          id: 'n1',
          title: 'GitHub admin',
          url: 'https://ns.example/n/n1',
          expiresInS: 600,
        },
      ],
    }
    render(<NeedsYouLauncher />)
    const pill = screen.getByTestId('needs-you-pill')
    expect(pill).toHaveTextContent('2 need you')
    expect(pill).toHaveAccessibleName(
      'Needs you: 1 agent question and 1 approval waiting',
    )
  })

  it('is a labelled tool with its count in the session list', () => {
    state.asks = [ask()]
    render(<NeedsYouLauncher variant="tool" />)
    const pill = screen.getByTestId('needs-you-pill')
    expect(pill).toHaveTextContent(/^Needs you1$/)
    expect(pill).toHaveAccessibleName('Needs you: 1 agent question waiting')
  })

  it('stays a quiet icon when nothing waits, and off the phone bar', () => {
    const { unmount } = render(<NeedsYouLauncher />)
    expect(screen.getByTestId('needs-you-pill')).toHaveAccessibleName(
      'Needs you: no agent questions or approvals waiting',
    )
    unmount()
    render(<NeedsYouLauncher variant="compact" />)
    expect(screen.queryByTestId('needs-you-pill')).toBeNull()
  })

  it('opens on the push link, drops it from the address and survives the bar giving way to the list', () => {
    state.asks = [ask()]
    window.history.replaceState(null, '', '/?session=0123abcd&ask=abcdefabcdef')
    const { rerender } = render(
      <NeedsYouLauncher key="bar" variant="compact" />,
    )
    expect(screen.getByTestId('needs-you-drawer')).toBeInTheDocument()
    expect(window.location.search).toBe('?session=0123abcd')
    // A wide window: the session list mounts its own launcher, the bar's goes.
    rerender(<NeedsYouLauncher key="list" />)
    expect(screen.getAllByTestId('needs-you-drawer')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('needs-you-drawer')).toBeNull()
  })
})

describe('NeedsYouDrawer', () => {
  it('marks the recommendation and sends the pick with the note', async () => {
    state.asks = [ask()]
    render(<NeedsYouDrawer open onOpenChange={() => {}} />)
    const card = screen.getByTestId('ask-card')
    expect(card).toHaveTextContent('Disk merge')
    expect(card).toHaveTextContent('agent is waiting')
    const choices = within(card).getAllByRole('radio')
    expect(choices[0]).toHaveAttribute('data-recommended', 'true')
    expect(choices[0]).toHaveTextContent('recommended')
    expect(choices[1]).not.toHaveAttribute('data-recommended')
    expect(
      within(card).getByText('sudo st disk merge --apply'),
    ).toBeInTheDocument()

    const send = within(card).getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    fireEvent.click(choices[1] as HTMLElement)
    fireEvent.change(within(card).getByLabelText('Note to the agent'), {
      target: { value: 'after the backup' },
    })
    fireEvent.click(send)
    expect(state.sent).toEqual([
      {
        id: 'abcdefabcdef',
        reply: { kind: 'answer', option: 1, note: 'after the backup' },
      },
    ])
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Sent to “Disk merge”: Stop here, “after the backup”. See Answered',
    )
  })

  it('replies Done for a question without choices, and opens the session', () => {
    state.asks = [ask({ options: [], recommended: null, command: null })]
    render(<NeedsYouDrawer open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reply “Done”' }))
    expect(
      screen.getByRole('button', { name: 'Reply “Not now”' }),
    ).toHaveAttribute('title', 'Tells the agent: Not now')
    expect(state.sent).toEqual([
      { id: 'abcdefabcdef', reply: { kind: 'answer', text: 'Done' } },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(push).toHaveBeenCalledWith(
      expect.stringContaining('session=0123abcd'),
      {
        scroll: false,
      },
    )
  })

  it('lists approvals as links to Nightshift, with no approve button', () => {
    state.approvals = {
      state: 'ok',
      taps: [
        {
          id: 'n1',
          title: 'GitHub admin for 15 min',
          url: 'https://ns.example/n/n1',
          expiresInS: 840,
        },
      ],
    }
    render(<NeedsYouDrawer open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: /Approvals/ }))
    const link = screen.getByRole('link', { name: 'Approve in Nightshift →' })
    expect(link).toHaveAttribute('href', 'https://ns.example/n/n1')
    expect(screen.getByText(/expires in 14m/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
  })

  it('says when Nightshift cannot be read instead of showing nothing waiting', () => {
    state.approvals = { state: 'unavailable', taps: [] }
    render(<NeedsYouDrawer open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: /Approvals/ }))
    expect(
      screen.getByText(/Can’t read Nightshift’s approvals/),
    ).toBeInTheDocument()
  })

  it('has its own loading, failed and empty copy', () => {
    state.isLoading = true
    const { rerender } = render(<NeedsYouDrawer open onOpenChange={() => {}} />)
    expect(screen.getByText('Loading questions…')).toBeInTheDocument()
    state.isLoading = false
    state.isError = true
    rerender(<NeedsYouDrawer open onOpenChange={() => {}} />)
    expect(screen.getByText(/Couldn’t load questions/)).toBeInTheDocument()
    state.isError = false
    rerender(<NeedsYouDrawer open onOpenChange={() => {}} />)
    expect(screen.getByText(/No agent questions waiting/)).toBeInTheDocument()
  })

  it('shows what was answered and how it reaches the agent', () => {
    state.asks = [
      ask({
        state: 'answered',
        answer: 'Stop here',
        note: 'after the backup',
        delivery: 'wake',
        answeredAt: NOW - 60_000,
        updatedAt: NOW - 60_000,
      }),
      ask({
        id: '222222222222',
        state: 'answered',
        answer: 'Not now',
        delivery: 'pull',
      }),
    ]
    render(<NeedsYouDrawer open onOpenChange={() => {}} focus="222222222222" />)
    const cards = screen.getAllByTestId('answered-card')
    expect(cards[0]).toHaveTextContent('can’t be messaged')
    expect(cards[1]).toHaveTextContent(
      'You answered Stop here: “after the backup”',
    )
    expect(cards[1]).toHaveTextContent('Sent to the session')
    fireEvent.click(
      within(cards[1] as HTMLElement).getByRole('button', { name: 'Clear' }),
    )
    expect(state.sent).toEqual([
      { id: 'abcdefabcdef', reply: { kind: 'done' } },
    ])
  })
})
