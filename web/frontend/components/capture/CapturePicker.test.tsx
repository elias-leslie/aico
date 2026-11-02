// The two equal ways in: Take photo (touch screens) and Choose files (a
// multi-select with the server's accept string); drop and paste on a computer.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapturePicker } from './CapturePicker'

const media = vi.hoisted(() => ({ touch: true }))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => media.touch,
}))

const jpeg = () => new File(['x'], 'a.jpg', { type: 'image/jpeg' })

describe('CapturePicker', () => {
  beforeEach(() => {
    media.touch = true
  })

  it('offers Take photo and Choose files on a touch screen', () => {
    render(<CapturePicker accept=".jpg,.pdf" onFiles={vi.fn()} />)
    const photo = screen.getByLabelText('Take photo') as HTMLInputElement
    const files = screen.getByLabelText('Choose files') as HTMLInputElement
    expect(photo.type).toBe('file')
    expect(photo.getAttribute('capture')).toBe('environment')
    expect(photo.accept).toBe('image/*')
    expect(photo.multiple).toBe(false)
    expect(files.multiple).toBe(true)
    expect(files.accept).toBe('.jpg,.pdf')
    // The camera hint belongs to Take photo alone.
    expect(files.hasAttribute('capture')).toBe(false)
  })

  it('shows only Choose files, with a drop hint, on a computer', () => {
    media.touch = false
    render(<CapturePicker onFiles={vi.fn()} />)
    expect(screen.queryByLabelText('Take photo')).toBeNull()
    expect(screen.getByLabelText('Choose files')).toBeInTheDocument()
    expect(screen.getByText(/drop files here/i)).toBeInTheDocument()
  })

  it('hands over every chosen file', () => {
    const onFiles = vi.fn()
    render(<CapturePicker onFiles={onFiles} />)
    const files = [
      jpeg(),
      new File(['p'], 'b.pdf', { type: 'application/pdf' }),
    ]
    fireEvent.change(screen.getByLabelText('Choose files'), {
      target: { files },
    })
    expect(onFiles).toHaveBeenCalledWith(files)
  })

  it('takes dropped and pasted files, and nothing when disabled', () => {
    const onFiles = vi.fn()
    const { rerender } = render(<CapturePicker onFiles={onFiles} />)
    const file = jpeg()
    fireEvent.drop(screen.getByTestId('capture-picker'), {
      dataTransfer: { files: [file] },
    })
    expect(onFiles).toHaveBeenLastCalledWith([file])

    const paste = new Event('paste', { cancelable: true }) as Event & {
      clipboardData?: unknown
    }
    paste.clipboardData = { files: [file] }
    window.dispatchEvent(paste)
    expect(onFiles).toHaveBeenCalledTimes(2)

    rerender(<CapturePicker onFiles={onFiles} disabled />)
    fireEvent.drop(screen.getByTestId('capture-picker'), {
      dataTransfer: { files: [file] },
    })
    window.dispatchEvent(paste)
    expect(onFiles).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText('Choose files')).toBeDisabled()
  })
})
