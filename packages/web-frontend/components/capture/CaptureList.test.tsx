// The Captures list: loading, empty, failed, stale and the rows, with the
// thumbnail or an icon.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture } from '@/lib/api/captures'
import { CaptureList } from './CaptureList'

const state = vi.hoisted(() => ({ list: {} as Record<string, unknown> }))
vi.mock('@/lib/hooks/use-captures', () => ({ useCaptures: () => state.list }))

const capture = (over: Partial<Capture> = {}): Capture => ({
  id: 'abcdef012345',
  clientId: 'c',
  groupId: null,
  askId: null,
  kind: 'image',
  name: 'IMG_1.jpg',
  mime: 'image/jpeg',
  size: 2048,
  caption: '',
  status: 'new',
  type: null,
  text: null,
  createdAt: Date.now() - 60_000,
  updatedAt: 1,
  hasThumb: true,
  previewState: 'ready',
  ...over,
})

const base = {
  captures: [] as Capture[],
  total: 0,
  loaded: true,
  isLoading: false,
  isError: false,
  isStale: false,
  error: null,
  updatedAt: Date.now(),
  hasMore: false,
  loadingMore: false,
  loadMore: vi.fn(),
  refetch: vi.fn(),
}

beforeEach(() => {
  state.list = { ...base }
})

describe('CaptureList', () => {
  it('says it is loading rather than empty', () => {
    state.list = { ...base, isLoading: true, loaded: false }
    render(<CaptureList />)
    expect(screen.getByText('Loading captures…')).toBeInTheDocument()
    expect(screen.queryByTestId('captures-empty')).toBeNull()
  })

  it('says there is nothing yet, and how to add something', () => {
    render(<CaptureList />)
    expect(screen.getByTestId('captures-empty')).toHaveTextContent(
      'No captures yet. Tap Capture',
    )
  })

  it('shows a failed first load as failed, not empty, with a retry', () => {
    state.list = {
      ...base,
      isError: true,
      loaded: false,
      error: 'Request failed',
    }
    render(<CaptureList />)
    expect(screen.getByTestId('captures-failed')).toHaveTextContent(
      "Couldn't load captures: Request failed",
    )
    expect(screen.queryByTestId('captures-empty')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(base.refetch).toHaveBeenCalled()
  })

  it('keeps the list and says it is stale when a refresh fails', () => {
    state.list = {
      ...base,
      captures: [capture()],
      total: 1,
      isStale: true,
      updatedAt: Date.now() - 5 * 60_000,
    }
    render(<CaptureList />)
    expect(screen.getByTestId('captures-stale')).toHaveTextContent(
      "Couldn't refresh. This is the list from 5m ago.",
    )
    expect(screen.getAllByTestId('capture-item')).toHaveLength(1)
  })

  it('lists each capture with its caption, link and status', () => {
    state.list = {
      ...base,
      captures: [
        capture({ caption: 'Receipt' }),
        capture({
          id: '0123456789ab',
          kind: 'pdf',
          name: 'form.pdf',
          mime: 'application/pdf',
          hasThumb: false,
          status: 'failed',
        }),
      ],
      total: 2,
    }
    render(<CaptureList />)
    const items = screen.getAllByTestId('capture-item')
    expect(items[0]).toHaveTextContent('Receipt')
    expect(items[0]).toHaveTextContent('IMG_1.jpg')
    expect(items[0]).toHaveTextContent('Saved')
    expect(items[0].getAttribute('href')).toBe('/captures?id=abcdef012345')
    expect(items[0].querySelector('img')?.getAttribute('src')).toBe(
      '/api/captures/abcdef012345/thumb',
    )
    expect(items[1]).toHaveTextContent('form.pdf')
    expect(items[1]).toHaveTextContent("Couldn't read")
    expect(items[1].querySelector('img')).toBeNull()
    expect(screen.getByText('2 captures')).toBeInTheDocument()
  })

  it('pages older captures in', () => {
    state.list = { ...base, captures: [capture()], total: 40, hasMore: true }
    render(<CaptureList />)
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }))
    expect(base.loadMore).toHaveBeenCalled()
  })

  it('puts the route in the row: the question, waiting, failed and sent', () => {
    const r = (state: string, canSend = true) => ({
      state: state as 'suggested',
      owner: 'portfolio-ai',
      ownerLabel: 'Portfolio AI',
      ownerRef: null,
      note: null,
      question: null,
      notLabel: null,
      canSend,
      url: null,
    })
    state.list = {
      ...base,
      total: 5,
      captures: [
        capture({ id: 'aaaaaaaaaaa1', route: r('suggested') }),
        capture({ id: 'aaaaaaaaaaa2', route: r('waiting') }),
        capture({ id: 'aaaaaaaaaaa3', route: r('failed') }),
        capture({ id: 'aaaaaaaaaaa4', route: r('filed'), status: 'filed' }),
        capture({
          id: 'aaaaaaaaaaa5',
          route: r('suggested', false),
          status: 'ready',
        }),
      ],
    }
    render(<CaptureList />)
    expect(
      screen.getAllByTestId('capture-route-word').map((n) => n.textContent),
    ).toEqual([
      'Send to Portfolio AI?',
      'Waiting for Portfolio AI',
      "Couldn't send to Portfolio AI",
      'Sent to Portfolio AI',
    ])
  })
})
