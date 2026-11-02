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
  useDeleteCapture: () => ({
    mutate: (id: string) => state.deleted.push(id),
    isPending: false,
    isError: false,
    error: null,
  }),
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
