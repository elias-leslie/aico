// The Needs you pill and drawer: the count, the recommendation marked, the
// answer sent as picked, approvals as links only, and an honest state for
// each of loading, empty and failed.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Approvals, OwnerAsk } from '@/lib/hooks/use-asks'
import {
  closeNeedsYou,
  NeedsYouDrawer,
  NeedsYouLauncher,
  NeedsYouPanel,
  openNeedsYou,
  useHostNeedsYou,
  useNeedsYouState,
} from './NeedsYou'

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
    sessions: [
      { id: '0123abcd', name: 'Disk merge' },
      { id: '89abcdef', name: 'Disk coordinator' },
    ],
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
  act(() => closeNeedsYou())
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

describe('Needs you beside the session list', () => {
  function ListHost({ children }: { children: ReactNode }) {
    useHostNeedsYou()
    return <>{children}</>
  }
  function OpenProbe() {
    const { open } = useNeedsYouState()
    return <p data-testid="open-probe">{open ? 'open' : 'closed'}</p>
  }

  it('opens no drawer while a session list is on screen to hold it', () => {
    state.asks = [ask()]
    render(
      <ListHost>
        <NeedsYouLauncher variant="tool" />
      </ListHost>,
    )
    fireEvent.click(screen.getByTestId('needs-you-pill'))
    expect(screen.queryByTestId('needs-you-drawer')).toBeNull()
  })

  it('goes back from its arrow or Esc, and offers the way back once nothing is left', async () => {
    state.asks = [ask()]
    const { rerender } = render(<NeedsYouPanel />)
    const panel = screen.getByTestId('needs-you-panel')
    expect(
      within(panel).getByRole('heading', { name: 'Needs you' }),
    ).toBeVisible()
    const backButton = screen.getByRole('button', { name: 'Back to sessions' })
    expect(backButton).toHaveFocus()

    const card = screen.getByTestId('ask-card')
    fireEvent.click(within(card).getAllByRole('radio')[0] as HTMLElement)
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }))
    await screen.findByRole('status')
    state.asks = [{ ...ask(), state: 'answered' }]
    rerender(<NeedsYouPanel />)
    expect(panel).toHaveTextContent('Nothing else waiting.')
    expect(
      screen.getAllByRole('button', { name: 'Back to sessions' }),
    ).toHaveLength(2)

    // Esc from inside it goes back; the session never sees the key.
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    render(<OpenProbe />)
    act(() => openNeedsYou())
    expect(screen.getByTestId('open-probe')).toHaveTextContent('open')
    fireEvent.keyDown(backButton, { key: 'Escape' })
    expect(outer).not.toHaveBeenCalled()
    expect(screen.getByTestId('open-probe')).toHaveTextContent('closed')
    document.removeEventListener('keydown', outer)
  })

  it('toggles the bar dropdown from its button', () => {
    state.asks = [ask()]
    render(<NeedsYouLauncher />)
    const pill = screen.getByTestId('needs-you-pill')
    fireEvent.click(pill)
    expect(screen.getByTestId('needs-you-drawer')).toBeInTheDocument()
    fireEvent.click(pill)
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

  it('says which session gets the answer, and nothing on an older Tether', () => {
    const routeOf = (patch: Partial<OwnerAsk>) => {
      state.asks = [ask(patch)]
      const { unmount } = render(
        <NeedsYouDrawer open onOpenChange={() => {}} />,
      )
      const line = screen.queryByTestId('answer-route')
      const seen = line && {
        text: line.textContent,
        title: line.getAttribute('title'),
      }
      unmount()
      return seen
    }
    expect(routeOf({ answerTo: '0123abcd' })?.text).toBe(
      'Answer goes to “Disk merge”',
    )
    expect(routeOf({ launcher: '89abcdef', answerTo: '89abcdef' })).toEqual({
      text: 'Answer goes to “Disk coordinator” (asker ended)',
      title:
        'Answer goes to “Disk coordinator” (asker ended). The session that asked has ended, so the session that launched it gets the answer.',
    })
    expect(routeOf({ answerTo: 'fedcba98' })?.text).toBe(
      'Answer goes to session fedcba98 (asker ended)',
    )
    expect(routeOf({ answerTo: null })).toEqual({
      text: 'No session will get the answer',
      title:
        'No session will get the answer. The agent reads it when it checks.',
    })
    expect(routeOf({})).toBeNull()
  })

  it('names the launcher when the answer went there', async () => {
    state.asks = [ask({ launcher: '89abcdef', answerTo: '89abcdef' })]
    render(<NeedsYouDrawer open onOpenChange={() => {}} />)
    const card = screen.getByTestId('ask-card')
    fireEvent.click(within(card).getAllByRole('radio')[0] as HTMLElement)
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Sent to “Disk coordinator”: Finish it now.',
    )
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
