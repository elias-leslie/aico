// The open session's own question: only that session's, open while the agent
// waits, folded otherwise, answered in place on a desktop and handed to the
// Needs you sheet on the phone.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture, CaptureUpload } from '@/lib/api/captures'
import { dropAskCaptureQueue, setCaptureLimits } from '@/lib/capture-queue'
import type { OwnerAsk } from '@/lib/hooks/use-asks'
import {
  closeNeedsYou,
  NeedsYouLauncher,
  openNeedsYou,
  useNeedsYouState,
} from './NeedsYou'
import { SessionAsk } from './SessionAsk'

const state = vi.hoisted(() => ({
  asks: [] as OwnerAsk[],
  phone: false,
  sent: [] as unknown[],
  uploads: [] as {
    upload: CaptureUpload
    resolve: (capture: Capture) => void
  }[],
}))
vi.mock('@/lib/api/captures', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/captures')>()),
  uploadCapture: (upload: CaptureUpload) =>
    new Promise<Capture>((resolve) => {
      state.uploads.push({ upload, resolve })
    }),
  uploadThumb: async () => {},
  deleteCapture: async () => {},
}))
vi.mock('@/lib/capture-thumb', () => ({ makeThumbnail: async () => null }))
vi.mock('@/lib/hooks/use-captures', () => ({
  useCaptureLimits: () => ({
    limits: { max_bytes: 1000, max_files: 3, types: [], accept: '.jpg,.pdf' },
    isError: false,
  }),
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
  state.uploads = []
  dropAskCaptureQueue('abcdefabcdef')
  setCaptureLimits({ max_bytes: 1000, max_files: 3 })
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
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

  it('takes the files a question asks for, in place', async () => {
    state.asks = [
      ask({
        options: [],
        recommended: null,
        wantsFiles: { min: 1, max: 2, hint: 'the dashboard' },
      }),
    ]
    render(<SessionAsk sessionId="0123abcd" />)
    const card = screen.getByTestId('ask-card')
    expect(within(card).getByTestId('ask-files-count')).toHaveTextContent(
      '0 of 1-2 files · the dashboard',
    )
    fireEvent.change(within(card).getByLabelText('Choose files'), {
      target: {
        files: [
          new File([new Uint8Array(10)], 'dash.jpg', { type: 'image/jpeg' }),
        ],
      },
    })
    expect(state.uploads[0]?.upload.askId).toBe('abcdefabcdef')
    await act(async () =>
      state.uploads[0]?.resolve({
        id: '111111111111',
        clientId: 'c',
        groupId: null,
        askId: 'abcdefabcdef',
        kind: 'image',
        name: 'dash.jpg',
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
      }),
    )
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }))
    expect(state.sent).toEqual([
      {
        id: 'abcdefabcdef',
        reply: { kind: 'answer', files: ['111111111111'] },
      },
    ])
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

  it('steps aside on a desktop while Needs you is open beside it', () => {
    state.asks = [ask()]
    render(<SessionAsk sessionId="0123abcd" />)
    expect(screen.getByTestId('session-ask')).toBeVisible()
    act(() => openNeedsYou())
    expect(screen.queryByTestId('session-ask')).toBeNull()
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

  it('keeps the same sheet when the session’s question is answered in it', async () => {
    state.phone = true
    state.asks = [ask()]
    const tree = () => (
      <>
        <BarLauncher />
        <SessionAsk sessionId="0123abcd" />
      </>
    )
    const { rerender } = render(tree())
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Waiting on you: Finish the single Linux partition?. Answer',
      }),
    )
    const sheet = screen.getByTestId('needs-you-drawer')
    const card = within(sheet).getByTestId('ask-card')
    fireEvent.click(within(card).getAllByRole('radio')[0] as HTMLElement)
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }))
    await act(async () => {})
    state.asks = [{ ...ask(), state: 'answered' }]
    rerender(tree())
    expect(screen.getByTestId('needs-you-drawer')).toBe(sheet)
    expect(within(sheet).getByRole('status')).toHaveTextContent(
      'Sent to “Disk merge”: Finish it now.',
    )
  })
})

/** The phone session bar's own launcher, mounted before the strip. */
function BarLauncher() {
  return <NeedsYouLauncher variant="compact" />
}
