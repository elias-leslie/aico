// The Needs you pill and drawer: the count, the recommendation marked, the
// answer sent as picked, approvals as links only, and an honest state for
// each of loading, empty and failed.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture, CaptureUpload } from '@/lib/api/captures'
import { ApiError } from '@/lib/api-fetch'
import { dropAskCaptureQueue, setCaptureLimits } from '@/lib/capture-queue'
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
  /** The next answer is refused with this. */
  sendError: null as Error | null,
  uploads: [] as {
    upload: CaptureUpload
    resolve: (capture: Capture) => void
    reject: (error: Error) => void
  }[],
  deleted: [] as string[],
}))
vi.mock('@/lib/api/captures', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/captures')>()),
  uploadCapture: (upload: CaptureUpload) =>
    new Promise<Capture>((resolve, reject) => {
      state.uploads.push({ upload, resolve, reject })
      upload.signal?.addEventListener('abort', () =>
        reject(new ApiError('Cancelled', 0)),
      )
    }),
  uploadThumb: async () => {},
  deleteCapture: async (id: string) => {
    state.deleted.push(id)
  },
}))
vi.mock('@/lib/capture-thumb', () => ({ makeThumbnail: async () => null }))
vi.mock('@/lib/hooks/use-captures', () => ({
  useCaptureLimits: () => ({
    limits: { max_bytes: 1000, max_files: 3, types: [], accept: '.jpg,.pdf' },
    isError: false,
  }),
}))
vi.mock('@/lib/hooks/use-asks', async (importOriginal) => {
  const { useState } = await import('react')
  return {
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
    useAskReply: () => {
      const [error, setError] = useState<Error | null>(null)
      return {
        mutate: (value: unknown) => state.sent.push(value),
        mutateAsync: async (value: { id: string }) => {
          state.sent.push(value)
          if (state.sendError) {
            setError(state.sendError)
            throw state.sendError
          }
          setError(null)
          const saved = state.asks.find((item) => item.id === value.id)
          return { ask: { ...saved, state: 'answered', delivery: 'wake' } }
        },
        isPending: false,
        isError: error !== null,
        error,
      }
    },
  }
})
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
  state.sendError = null
  state.uploads = []
  state.deleted = []
  dropAskCaptureQueue('abcdefabcdef')
  setCaptureLimits({ max_bytes: 1000, max_files: 3 })
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
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
    act(() => openNeedsYou())
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

  it('leaves the keyboard with the session when a push link opens it, and Esc keeps a half-typed reply', () => {
    state.asks = [ask()]
    window.history.replaceState(null, '', '/?ask=abcdefabcdef')
    render(
      <ListHost>
        <NeedsYouLauncher variant="tool" />
        <OpenProbe />
      </ListHost>,
    )
    render(<NeedsYouPanel />)
    expect(screen.getByTestId('open-probe')).toHaveTextContent('open')
    expect(
      screen.getByRole('button', { name: 'Back to sessions' }),
    ).not.toHaveFocus()
    const note = screen.getByLabelText('Note to the agent')
    fireEvent.change(note, { target: { value: 'after the' } })
    fireEvent.keyDown(note, { key: 'Escape' })
    expect(screen.getByTestId('open-probe')).toHaveTextContent('open')
    fireEvent.change(note, { target: { value: '' } })
    fireEvent.keyDown(note, { key: 'Escape' })
    expect(screen.getByTestId('open-probe')).toHaveTextContent('closed')
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

describe('a card that asks for files', () => {
  const wants = (min: number, max: number, hint: string | null = null) =>
    ask({
      options: [],
      recommended: null,
      command: null,
      wantsFiles: { min, max, hint },
    })
  const file = (name: string, type = 'image/jpeg', size = 10) =>
    new File([new Uint8Array(size)], name, { type })
  const saved = (name: string, id: string): Capture => ({
    id,
    clientId: 'c',
    groupId: null,
    askId: 'abcdefabcdef',
    kind: 'image',
    name,
    mime: 'image/jpeg',
    size: 10,
    caption: '',
    status: 'new',
    type: null,
    text: null,
    createdAt: 1,
    updatedAt: 1,
    hasThumb: false,
    previewState: 'ready',
  })
  const choose = (...files: File[]) =>
    fireEvent.change(screen.getByLabelText('Choose files'), {
      target: { files },
    })
  const card = () => screen.getByTestId('ask-card')
  const open = (patch = wants(1, 3, 'any photo or PDF')) => {
    state.asks = [patch]
    return render(<NeedsYouDrawer open onOpenChange={() => {}} />)
  }
  const send = () =>
    within(card()).getByRole('button', { name: /^(Send|Waiting|Add \d+ more)/ })
  const land = async (index: number, name: string, id: string) =>
    act(async () => state.uploads[index]?.resolve(saved(name, id)))

  it('idle: the count and hint, and Send says what is missing; there is no way to answer a minimum away', () => {
    open(wants(2, 5, 'any 2-3 photos'))
    expect(screen.getByTestId('ask-files-count')).toHaveTextContent(
      '0 of 2-5 files · any 2-3 photos',
    )
    expect(send()).toBeDisabled()
    expect(send()).toHaveTextContent('Add 2 more photos')
    expect(
      within(card()).queryByRole('button', { name: 'Answer without files' }),
    ).toBeNull()
    // Done is not an answer to a question that asked for files.
    expect(within(card()).queryByRole('button', { name: /Done/ })).toBeNull()
    // Typing a note does not open it.
    fireEvent.change(within(card()).getByLabelText('Reply to the agent'), {
      target: { value: 'no camera here' },
    })
    expect(send()).toBeDisabled()
  })

  it('Send counts down as files are saved, and names files when the ask gave no hint', async () => {
    open(wants(2, 3))
    expect(send()).toHaveTextContent('Add 2 more files')
    choose(file('a.jpg'))
    await land(0, 'a.jpg', '111111111111')
    expect(send()).toHaveTextContent('Add 1 more file')
    expect(send()).toBeDisabled()
    choose(file('b.jpg'))
    await land(1, 'b.jpg', '222222222222')
    expect(send()).toHaveTextContent('Send')
    expect(send()).toBeEnabled()
  })

  it('Reply "Not now" is the one answer a files ask takes without its files', () => {
    open(wants(2, 3))
    fireEvent.click(
      within(card()).getByRole('button', { name: 'Reply “Not now”' }),
    )
    expect(state.sent).toEqual([
      {
        id: 'abcdefabcdef',
        reply: { kind: 'answer', text: 'Not now', skippedFiles: true },
      },
    ])
  })

  it('a card that asks for no files has no files block', () => {
    open(ask())
    expect(screen.queryByTestId('ask-files')).toBeNull()
  })

  it('uploading: a row with progress and Cancel, and Send waits', async () => {
    open()
    choose(file('odometer.jpg'))
    expect(state.uploads).toHaveLength(1)
    const upload = state.uploads[0]?.upload as CaptureUpload
    expect(upload.askId).toBe('abcdefabcdef')
    expect(upload.groupId).toBeUndefined()
    await act(async () => upload.onProgress?.(40))
    const row = screen.getByTestId('ask-file-row')
    expect(row).toHaveAttribute('data-state', 'sending')
    expect(row).toHaveTextContent('odometer.jpg')
    expect(row).toHaveTextContent('Sending 40%')
    expect(
      within(row).getByRole('progressbar', { name: 'Sending odometer.jpg' }),
    ).toHaveValue(40)
    expect(send()).toHaveTextContent('Waiting for 1 upload')
    expect(send()).toBeDisabled()
    expect(screen.getByTestId('ask-files-count')).toHaveTextContent('1 of 1-3')

    await act(async () =>
      fireEvent.click(
        within(row).getByRole('button', { name: 'Cancel odometer.jpg' }),
      ),
    )
    expect(screen.queryByTestId('ask-file-row')).toBeNull()
    expect(screen.getByTestId('ask-files-count')).toHaveTextContent('0 of 1-3')
  })

  it('saved: thumbnail, name, size and Remove (which deletes the capture); Send then answers with the ids', async () => {
    open()
    choose(file('odometer.jpg'), file('dash.jpg'))
    await land(0, 'odometer.jpg', '111111111111')
    expect(send()).toHaveTextContent('Waiting for 1 upload')
    await land(1, 'dash.jpg', '222222222222')
    const rows = screen.getAllByTestId('ask-file-row')
    expect(rows[0]).toHaveAttribute('data-state', 'sent')
    expect(rows[0]).toHaveTextContent('10 B · Saved')
    expect(send()).toBeEnabled()
    expect(send()).toHaveTextContent('Send')

    await act(async () =>
      fireEvent.click(
        within(rows[1] as HTMLElement).getByRole('button', {
          name: 'Remove dash.jpg',
        }),
      ),
    )
    expect(state.deleted).toEqual(['222222222222'])
    expect(screen.getAllByTestId('ask-file-row')).toHaveLength(1)

    fireEvent.click(send())
    expect(state.sent).toEqual([
      {
        id: 'abcdefabcdef',
        reply: { kind: 'answer', files: ['111111111111'] },
      },
    ])
    // Sent: the card leaves like any answered ask, saying what went.
    expect(
      await screen.findByText(/Sent to “Disk merge”: 1 file\./),
    ).toBeInTheDocument()
  })

  it('sends files with a note, in the order shown', async () => {
    open(wants(0, 3))
    choose(file('a.jpg'), file('b.jpg'))
    await land(0, 'a.jpg', '111111111111')
    await land(1, 'b.jpg', '222222222222')
    fireEvent.change(within(card()).getByLabelText('Reply to the agent'), {
      target: { value: 'both sides' },
    })
    fireEvent.click(send())
    expect(state.sent).toEqual([
      {
        id: 'abcdefabcdef',
        reply: {
          kind: 'answer',
          note: 'both sides',
          files: ['111111111111', '222222222222'],
        },
      },
    ])
  })

  it('failed: the reason in words with Retry (same id) or Remove, and never sent', async () => {
    open()
    choose(file('a.pdf', 'application/pdf'))
    await act(async () =>
      state.uploads[0]?.reject(
        new ApiError("Aico can't store this kind of file yet", 415),
      ),
    )
    const row = screen.getByTestId('ask-file-row')
    expect(row).toHaveAttribute('data-state', 'failed')
    expect(row).toHaveTextContent("Aico can't store this kind of file yet")
    expect(send()).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 file didn’t upload. Retry it or remove it.',
    )

    const clientId = state.uploads[0]?.upload.clientId
    fireEvent.click(within(row).getByRole('button', { name: 'Retry a.pdf' }))
    expect(state.uploads).toHaveLength(2)
    expect(state.uploads[1]?.upload.clientId).toBe(clientId)
    await act(async () =>
      state.uploads[1]?.reject(
        new ApiError('Aico is unreachable, try again', 0),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }))
    expect(screen.queryByTestId('ask-file-row')).toBeNull()
    expect(state.deleted).toEqual([])
  })

  it('a file over the limit fails before it is sent', () => {
    setCaptureLimits({ max_bytes: 2 * 1024 * 1024, max_files: 3 })
    open()
    choose(file('big.jpg', 'image/jpeg', 3 * 1024 * 1024))
    expect(state.uploads).toHaveLength(0)
    expect(screen.getByTestId('ask-file-row')).toHaveTextContent(
      'That file is over 2 MB',
    )
  })

  it('partial: Send is on once the saved files meet the minimum, off below it', async () => {
    open(wants(1, 3))
    choose(file('a.jpg'), file('b.pdf', 'application/pdf'))
    await land(0, 'a.jpg', '111111111111')
    await act(async () =>
      state.uploads[1]?.reject(new ApiError('That file is over 25 MB', 413)),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 file didn’t upload. Retry it or remove it.',
    )
    expect(send()).toBeEnabled()
    fireEvent.click(send())
    expect((state.sent[0] as { reply: unknown }).reply).toEqual({
      kind: 'answer',
      files: ['111111111111'],
    })
  })

  it('partial below the minimum keeps Send off', async () => {
    open(wants(2, 3))
    choose(file('a.jpg'), file('b.jpg'))
    await land(0, 'a.jpg', '111111111111')
    await act(async () =>
      state.uploads[1]?.reject(
        new ApiError('Aico is unreachable, try again', 0),
      ),
    )
    expect(send()).toBeDisabled()
    // Retrying brings it back.
    fireEvent.click(screen.getByRole('button', { name: 'Retry b.jpg' }))
    await land(2, 'b.jpg', '222222222222')
    expect(send()).toBeEnabled()
  })

  it('at the maximum: both controls off and the count says so', async () => {
    open(wants(1, 2))
    choose(file('a.jpg'), file('b.jpg'), file('c.jpg'))
    expect(state.uploads).toHaveLength(1)
    expect(screen.getAllByTestId('ask-file-row')).toHaveLength(2)
    expect(
      screen.getByText(/That is all this question takes. 1 not added/),
    ).toBeInTheDocument()
    expect(screen.getByTestId('ask-files-count')).toHaveTextContent(
      '2 of 2 files',
    )
    expect(screen.getByLabelText('Choose files')).toBeDisabled()
    // A failed file frees its place.
    await act(async () =>
      state.uploads[0]?.reject(
        new ApiError('Aico is unreachable, try again', 0),
      ),
    )
    expect(screen.getByLabelText('Choose files')).toBeEnabled()
  })

  it('answer failed: the files stay saved, the error shows, and Send tries again without uploading', async () => {
    open(wants(1, 3))
    choose(file('a.jpg'))
    await land(0, 'a.jpg', '111111111111')
    state.sendError = new Error('Could not send it. Try again.')
    await act(async () => fireEvent.click(send()))
    expect(state.sent).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not send it. Try again.',
    )
    expect(screen.getByTestId('ask-file-row')).toHaveAttribute(
      'data-state',
      'sent',
    )
    expect(send()).toBeEnabled()
    state.sendError = null
    await act(async () => fireEvent.click(send()))
    expect(state.sent).toHaveLength(2)
    expect(state.sent[1]).toEqual(state.sent[0])
    expect(state.uploads).toHaveLength(1)
  })

  it('closed meanwhile: says so and that the files are kept', async () => {
    open(wants(1, 3))
    choose(file('a.jpg'))
    await land(0, 'a.jpg', '111111111111')
    state.sendError = new Error(
      'This question was closed. Your files are kept in Captures.',
    )
    await act(async () => fireEvent.click(send()))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This question was closed. Your files are kept in Captures.',
    )
    expect(state.deleted).toEqual([])
  })

  it('keeps its files when the drawer closes and opens again, and starts clean after a send', async () => {
    const { unmount } = open(wants(1, 3))
    choose(file('a.jpg'))
    await land(0, 'a.jpg', '111111111111')
    unmount()
    open(wants(1, 3))
    expect(screen.getByTestId('ask-file-row')).toHaveTextContent('a.jpg')
    await act(async () => fireEvent.click(send()))
    cleanup()
    open(wants(1, 3))
    expect(screen.queryByTestId('ask-file-row')).toBeNull()
  })

  it('shows the files on the Answered tab', () => {
    state.asks = [
      ask({
        state: 'answered',
        options: [],
        answer: null,
        wantsFiles: { min: 1, max: 3, hint: null },
        delivery: 'wake',
        files: [
          {
            id: '111111111111',
            name: 'odometer.jpg',
            mime: 'image/jpeg',
            size: 10,
            path: '/x',
            host: 'door',
          },
          {
            id: '222222222222',
            name: 'invoice.pdf',
            mime: 'application/pdf',
            size: 10,
            path: '/y',
            host: 'door',
          },
        ],
      }),
    ]
    render(<NeedsYouDrawer open onOpenChange={() => {}} focus="abcdefabcdef" />)
    const answered = screen.getByTestId('answered-card')
    expect(answered).toHaveTextContent('You sent 2 files')
    const files = within(answered).getAllByTestId('answered-file')
    expect(files).toHaveLength(2)
    expect(
      within(files[0] as HTMLElement).getByRole('link', {
        name: 'Open odometer.jpg',
      }),
    ).toHaveAttribute('href', '/api/captures/111111111111/file')
    expect(
      within(files[0] as HTMLElement).getByRole('presentation', {
        hidden: true,
      }),
    ).toHaveAttribute('src', '/api/captures/111111111111/thumb')
    // A PDF has no picture: an icon, not a broken image.
    expect(
      within(files[1] as HTMLElement).queryByRole('presentation', {
        hidden: true,
      }),
    ).toBeNull()
  })
})
