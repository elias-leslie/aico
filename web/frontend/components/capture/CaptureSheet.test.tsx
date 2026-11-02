// The queue's states (waiting, sending with progress, sent, failed), retry,
// remove, and the caption going out with the file.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture, CaptureUpload } from '@/lib/api/captures'
import { ApiError } from '@/lib/api-fetch'
import { resetCaptureQueue, setCaptureLimits } from '@/lib/capture-queue'
import { CaptureSheet } from './CaptureSheet'

const api = vi.hoisted(() => ({
  uploads: [] as {
    upload: CaptureUpload
    resolve: (capture: Capture) => void
    reject: (error: Error) => void
  }[],
  thumbs: [] as string[],
}))
vi.mock('@/lib/api/captures', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/captures')>()),
  uploadCapture: (upload: CaptureUpload) =>
    new Promise<Capture>((resolve, reject) => {
      api.uploads.push({ upload, resolve, reject })
    }),
  uploadThumb: async (id: string) => {
    api.thumbs.push(id)
  },
}))
vi.mock('@/lib/capture-thumb', () => ({
  makeThumbnail: async () => new Blob(['j'], { type: 'image/jpeg' }),
}))
vi.mock('@/lib/hooks/use-captures', () => ({
  useCaptureLimits: () => ({
    limits: { max_bytes: 1000, max_files: 3, types: [], accept: '.jpg,.pdf' },
    isError: false,
  }),
  useRefreshCaptures: () => () => {},
}))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => true }))

const file = (name: string, type = 'image/jpeg', size = 10) =>
  new File([new Uint8Array(size)], name, { type })

const saved = (name: string): Capture => ({
  id: 'a'.repeat(12),
  clientId: 'c',
  groupId: null,
  askId: null,
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

function choose(...files: File[]) {
  fireEvent.change(screen.getByLabelText('Choose files'), {
    target: { files },
  })
}

beforeEach(() => {
  api.uploads.length = 0
  api.thumbs.length = 0
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  setCaptureLimits({ max_bytes: 1000, max_files: 3 })
})
afterEach(() => resetCaptureQueue())

describe('CaptureSheet', () => {
  it('starts empty with nothing to send', () => {
    render(<CaptureSheet open onOpenChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.queryByRole('list', { name: 'Files to send' })).toBeNull()
  })

  it('queues files, sends them one at a time with the caption, and ends sent', async () => {
    render(<CaptureSheet open onOpenChange={() => {}} />)
    choose(file('a.jpg'), file('b.pdf', 'application/pdf'))
    expect(screen.getAllByTestId('capture-row')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText(/Caption/), {
      target: { value: 'Receipt' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 files' }))

    expect(api.uploads).toHaveLength(1)
    const first = api.uploads[0].upload
    expect(first.caption).toBe('Receipt')
    expect(first.file.name).toBe('a.jpg')
    expect(first.groupId).toBeTruthy()
    expect(first.clientId).toMatch(/^[0-9a-f-]{36}$/)

    await act(async () => {
      first.onProgress?.(40)
    })
    expect(screen.getByText(/Sending 40%/)).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', { name: 'Sending a.jpg' }),
    ).toHaveValue(40)

    await act(async () => api.uploads[0].resolve(saved('a.jpg')))
    expect(api.uploads).toHaveLength(2)
    expect(api.thumbs).toEqual(['a'.repeat(12)])
    await act(async () =>
      api.uploads[1].resolve({ ...saved('b.pdf'), kind: 'pdf' }),
    )
    expect(screen.getByText('All 2 sent.')).toBeInTheDocument()
    expect(api.uploads[1].upload.groupId).toBe(first.groupId)
    fireEvent.click(screen.getByRole('button', { name: 'Add more' }))
    expect(screen.queryAllByTestId('capture-row')).toHaveLength(0)
  })

  it('keeps a failed file with the reason, retries it under the same id, and says what was partial', async () => {
    render(<CaptureSheet open onOpenChange={() => {}} />)
    choose(file('a.jpg'), file('b.pdf', 'application/pdf'))
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 files' }))
    await act(async () => api.uploads[0].resolve(saved('a.jpg')))
    await act(async () =>
      api.uploads[1].reject(
        new ApiError("Aico can't store this kind of file yet", 415),
      ),
    )
    expect(screen.getByText('1 of 2 sent. 1 failed.')).toBeInTheDocument()
    const rows = screen.getAllByTestId('capture-row')
    expect(rows[0]).toHaveAttribute('data-state', 'sent')
    expect(
      within(rows[1]).getByText(/can't store this kind of file/),
    ).toBeInTheDocument()

    const failedId = api.uploads[1].upload.clientId
    fireEvent.click(screen.getByRole('button', { name: 'Retry b.pdf' }))
    expect(api.uploads).toHaveLength(3)
    expect(api.uploads[2].upload.clientId).toBe(failedId)
    await act(async () =>
      api.uploads[2].resolve({ ...saved('b.pdf'), kind: 'pdf' }),
    )
    expect(screen.getByText('All 2 sent.')).toBeInTheDocument()
  })

  it('removes a waiting file before sending', () => {
    render(<CaptureSheet open onOpenChange={() => {}} />)
    choose(file('a.jpg'), file('b.jpg'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.jpg' }))
    expect(screen.getAllByTestId('capture-row')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })

  it('refuses a file over the limit and files past the count, in words', () => {
    render(<CaptureSheet open onOpenChange={() => {}} />)
    choose(file('big.jpg', 'image/jpeg', 5000))
    expect(screen.getByText(/That file is over/)).toBeInTheDocument()
    choose(file('b.jpg'), file('c.jpg'), file('d.jpg'))
    expect(screen.getAllByTestId('capture-row')).toHaveLength(3)
    expect(
      screen.getByText(/3 files at a time. 1 not added/),
    ).toBeInTheDocument()
  })

  it('keeps the draft when the sheet closes and opens again', () => {
    const { rerender } = render(<CaptureSheet open onOpenChange={() => {}} />)
    choose(file('a.jpg'))
    fireEvent.change(screen.getByLabelText(/Caption/), {
      target: { value: 'Hi' },
    })
    rerender(<CaptureSheet open={false} onOpenChange={() => {}} />)
    rerender(<CaptureSheet open onOpenChange={() => {}} />)
    expect(screen.getAllByTestId('capture-row')).toHaveLength(1)
    expect(screen.getByLabelText(/Caption/)).toHaveValue('Hi')
  })
})
