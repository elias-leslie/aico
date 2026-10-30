import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPLOAD_DONE_MS, UploadDoneToast } from './UploadStatusToast'

describe('UploadDoneToast', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the file, the host and the path, then goes by itself', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(
      <UploadDoneToast
        upload={{
          name: 'notes.txt',
          path: '/home/kasadis/.cache/aico/uploads/0b1c.txt',
          host: 'agent-work',
          typed: true,
        }}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sent notes.txt to agent-work',
    )
    expect(
      screen.getByText('/home/kasadis/.cache/aico/uploads/0b1c.txt'),
    ).toBeVisible()
    expect(
      screen.getByText('Path typed into the session, not sent.'),
    ).toBeVisible()
    act(() => vi.advanceTimersByTime(UPLOAD_DONE_MS))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('reads as this computer without a host, and dismisses on tap', () => {
    const onDismiss = vi.fn()
    render(
      <UploadDoneToast
        upload={{
          name: 'shot.png',
          path: '~/.cache/aico/uploads/9f.png',
          host: null,
          typed: false,
        }}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Uploaded shot.png')
    expect(screen.queryByText(/Path typed/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
