// One capture: loading, gone, failed, stale, the preview, an undecodable
// HEIC, the caption save and the delete confirmation.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture } from '@/lib/api/captures'
import { CaptureDetail } from './CaptureDetail'

const state = vi.hoisted(() => ({
  view: {} as Record<string, unknown>,
  saved: [] as unknown[],
  deleted: [] as string[],
  retried: [] as string[],
  routed: [] as unknown[],
  noteTitle: 'Groceries',
}))
vi.mock('@/lib/hooks/use-captures', () => ({
  useCapture: () => state.view,
  useSaveCaption: () => ({
    mutate: (value: unknown) => state.saved.push(value),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
  }),
  useRetryCapture: () => ({
    mutate: (id: string) => state.retried.push(id),
    isPending: false,
    isError: false,
    error: null,
  }),
  useRouteCapture: () => ({
    mutate: (value: unknown) => state.routed.push(value),
    isPending: false,
    isError: false,
    error: null,
  }),
  useDeleteCapture: () => ({
    mutate: (id: string) => state.deleted.push(id),
    isPending: false,
    isError: false,
    error: null,
  }),
}))
vi.mock('@/lib/hooks/use-notes', () => ({
  useNote: () => ({ note: { title: state.noteTitle } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))

const capture = (over: Partial<Capture> = {}): Capture => ({
  id: 'abcdef012345',
  clientId: 'c',
  groupId: null,
  askId: null,
  kind: 'image',
  name: 'IMG_1.jpg',
  mime: 'image/jpeg',
  size: 2048,
  caption: 'Receipt',
  status: 'new',
  type: null,
  text: null,
  createdAt: Date.now(),
  updatedAt: 1,
  hasThumb: true,
  previewState: 'ready',
  ...over,
})

const base = {
  capture: null as Capture | null,
  isLoading: false,
  gone: false,
  isError: false,
  isStale: false,
  error: null,
  updatedAt: Date.now(),
  refetch: vi.fn(),
}

beforeEach(() => {
  state.view = { ...base, capture: capture() }
  state.saved.length = 0
  state.deleted.length = 0
  state.retried.length = 0
  state.routed.length = 0
})

const route = (over: Partial<NonNullable<Capture['route']>> = {}) => ({
  state: 'suggested' as const,
  owner: 'portfolio-ai',
  ownerLabel: 'Portfolio AI',
  ownerRef: null,
  note: null,
  question: 'Send to Portfolio AI as a receipt?',
  notLabel: 'Not a receipt',
  canSend: true,
  url: null,
  ...over,
})

describe('CaptureDetail route', () => {
  const show = (over: Partial<Capture>) => {
    state.view = {
      ...base,
      capture: capture({
        status: 'ready',
        type: 'receipt',
        text: 'x',
        ...over,
      }),
    }
    render(<CaptureDetail id="abcdef012345" />)
  }

  it('asks the suggestion with Send, Not a receipt and Keep here', () => {
    show({ route: route() })
    expect(screen.getByTestId('capture-route')).toHaveTextContent(
      'Send to Portfolio AI as a receipt?',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not a receipt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep here' }))
    expect(state.routed).toEqual([
      { id: 'abcdef012345', action: 'send' },
      { id: 'abcdef012345', action: 'not_this' },
      { id: 'abcdef012345', action: 'keep' },
    ])
  })

  it('offers no button for an owner that is not built yet, only the reason', () => {
    show({
      type: 'receipt',
      route: route({
        owner: 'portfolio-ai',
        ownerLabel: 'Portfolio AI',
        canSend: false,
        question: 'File this as a receipt?',
        note: 'Receipts are coming soon, so this stays here for now.',
      }),
    })
    expect(screen.getByTestId('capture-route')).toHaveTextContent(
      'Receipts are coming soon',
    )
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('links to Shopping without saying the capture was sent', () => {
    show({
      type: 'grocery_list',
      route: route({
        owner: 'dadbot-shopping',
        ownerLabel: 'Dadbot Shopping',
        canSend: false,
        note: 'This stays in Aico. Add items in Dadbot Shopping yourself.',
        url: 'https://dadbot.summitflow.dev/shopping',
      }),
    })
    const block = screen.getByTestId('capture-route')
    expect(block).toHaveTextContent(
      'This stays in Aico. Add items in Dadbot Shopping yourself.',
    )
    expect(block).not.toHaveTextContent('Sent to')
    expect(
      screen.getByRole('link', { name: 'Open Dadbot Shopping' }),
    ).toHaveAttribute('href', 'https://dadbot.summitflow.dev/shopping')
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.getByRole('link', { name: /Download/ })).toBeInTheDocument()
    expect(state.routed).toEqual([])
  })

  it('says it is waiting and offers Send now; says why it failed and offers Try again', () => {
    show({
      route: route({
        state: 'waiting',
        note: "Portfolio AI isn't answering right now",
      }),
    })
    expect(screen.getByTestId('capture-route')).toHaveTextContent(
      'Waiting for Portfolio AI',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(state.routed).toEqual([{ id: 'abcdef012345', action: 'send' }])
  })

  it('shows the failure reason', () => {
    show({
      route: route({ state: 'failed', note: 'Portfolio AI said no (415)' }),
    })
    expect(screen.getByTestId('capture-route')).toHaveTextContent(
      "Couldn't send it to Portfolio AI: Portfolio AI said no (415)",
    )
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument()
  })

  it('shows a filed capture with the link and no download', () => {
    show({
      status: 'filed',
      hasFile: false,
      previewState: 'unavailable',
      hasThumb: false,
      route: route({
        state: 'filed',
        url: 'https://portfolio.example/capture',
      }),
    })
    expect(screen.getByTestId('capture-route')).toHaveTextContent(
      'Sent to Portfolio AI.',
    )
    expect(
      screen.getByRole('link', { name: /Open in Portfolio AI/ }),
    ).toHaveAttribute('href', 'https://portfolio.example/capture')
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull()
    expect(screen.queryByText(/couldn't make a preview/)).toBeNull()
  })

  it('links a capture filed in Notes to its note', () => {
    show({
      status: 'filed',
      route: route({
        state: 'filed',
        owner: 'notes',
        ownerLabel: 'Notes',
        ownerRef: '0123456789ab',
      }),
    })
    expect(screen.getByTestId('capture-route')).toHaveTextContent(
      'Filed in Notes: Groceries',
    )
    expect(screen.getByTestId('filed-note-link')).toHaveAttribute(
      'href',
      '/notes?id=0123456789ab',
    )
  })

  it('masks a secret in the filed note title', () => {
    state.noteTitle = 'bot 1234567890:AAH_0123456789abcdefghijklmnopqrstuvw'
    show({
      status: 'filed',
      route: route({
        state: 'filed',
        owner: 'notes',
        ownerLabel: 'Notes',
        ownerRef: '0123456789ab',
      }),
    })
    const link = screen.getByTestId('filed-note-link')
    expect(link.textContent).toContain('hidden')
    expect(link.textContent).not.toContain('AAH_0123456789')
    state.noteTitle = 'Groceries'
  })
})

describe('CaptureDetail', () => {
  it('says it is loading', () => {
    state.view = { ...base, isLoading: true }
    render(<CaptureDetail id="abcdef012345" />)
    expect(screen.getByText('Loading capture…')).toBeInTheDocument()
  })

  it('says a deleted capture is gone, and a failed load failed', () => {
    state.view = { ...base, gone: true, isError: true }
    const { unmount } = render(<CaptureDetail id="abcdef012345" />)
    expect(screen.getByTestId('capture-gone')).toBeInTheDocument()
    unmount()
    state.view = { ...base, isError: true, error: 'Request failed' }
    render(<CaptureDetail id="abcdef012345" />)
    expect(screen.getByTestId('capture-failed')).toHaveTextContent(
      "Couldn't load this capture: Request failed",
    )
  })

  it('keeps showing the capture and says so when a refresh fails', () => {
    state.view = { ...base, capture: capture(), isStale: true }
    render(<CaptureDetail id="abcdef012345" />)
    expect(screen.getByTestId('capture-stale')).toBeInTheDocument()
    expect(screen.getByTestId('capture-detail')).toBeInTheDocument()
  })

  it('shows the picture, the facts and that nothing has read it yet', () => {
    render(<CaptureDetail id="abcdef012345" />)
    expect(screen.getByTestId('capture-preview').getAttribute('src')).toBe(
      '/api/captures/abcdef012345/preview',
    )
    expect(screen.getByText('IMG_1.jpg')).toBeInTheDocument()
    expect(screen.getByText(/Waiting to be read/)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Download/ }).getAttribute('href'),
    ).toBe('/api/captures/abcdef012345/file')
  })

  it('says why there is no picture for a HEIC without a preview', () => {
    state.view = {
      ...base,
      capture: capture({
        name: 'IMG_2.heic',
        mime: 'image/heic',
        previewState: 'unavailable',
        hasThumb: false,
      }),
    }
    render(<CaptureDetail id="abcdef012345" />)
    expect(screen.queryByTestId('capture-preview')).toBeNull()
    expect(screen.getByText(/couldn't make a preview/)).toBeInTheDocument()
  })

  it('shows extracted text once there is some', () => {
    state.view = {
      ...base,
      capture: capture({
        kind: 'pdf',
        mime: 'application/pdf',
        text: 'Total 12.00',
      }),
    }
    render(<CaptureDetail id="abcdef012345" />)
    expect(screen.getByText('Total 12.00')).toBeInTheDocument()
  })

  it('shows reading since when, and a failure with Retry', () => {
    state.view = {
      ...base,
      capture: capture({ status: 'extracting', updatedAt: 1_700_000_000_000 }),
    }
    const { unmount } = render(<CaptureDetail id="abcdef012345" />)
    expect(screen.getByTestId('capture-reading')).toHaveTextContent(
      /Reading since \d/,
    )
    unmount()
    state.view = {
      ...base,
      capture: capture({
        status: 'failed',
        extractError: "the main reader isn't available",
      }),
    }
    render(<CaptureDetail id="abcdef012345" />)
    expect(screen.getByTestId('capture-unread')).toHaveTextContent(
      "Couldn't read it: the main reader isn't available",
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(state.retried).toEqual(['abcdef012345'])
  })

  it('shows list items with what was written, and a check note for the fallback reader', () => {
    state.view = {
      ...base,
      capture: capture({
        status: 'ready',
        text: 'see weeds',
        needsCheck: true,
        extract: {
          items: [
            {
              as_written: 'see weeds',
              item: 'seaweed',
              quantity: '2',
              struck: false,
            },
            { as_written: 'milk', item: 'milk', quantity: null, struck: true },
          ],
        },
      }),
    }
    render(<CaptureDetail id="abcdef012345" />)
    const items = screen.getByTestId('capture-items')
    expect(items).toHaveTextContent('seaweed')
    expect(items).toHaveTextContent('written: see weeds')
    expect(screen.getByText('milk').parentElement).toHaveStyle(
      'text-decoration: line-through',
    )
    expect(screen.getByTestId('capture-check')).toBeInTheDocument()
  })

  it('saves an edited caption only', () => {
    render(<CaptureDetail id="abcdef012345" />)
    const save = screen.getByRole('button', { name: 'Save caption' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Caption'), {
      target: { value: 'Receipt, lunch' },
    })
    fireEvent.click(save)
    expect(state.saved).toEqual([
      { id: 'abcdef012345', caption: 'Receipt, lunch' },
    ])
  })

  it('asks before deleting', () => {
    render(<CaptureDetail id="abcdef012345" />)
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }))
    expect(state.deleted).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(state.deleted).toEqual(['abcdef012345'])
  })
})
