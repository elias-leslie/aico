// The equal ways in: Camera, Photos and Files on a touch screen; Choose files
// plus drop and paste on a computer.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapturePicker, photoAccept } from './CapturePicker'

const media = vi.hoisted(() => ({ touch: true }))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => media.touch,
}))

const jpeg = () => new File(['x'], 'a.jpg', { type: 'image/jpeg' })

describe('CapturePicker', () => {
  beforeEach(() => {
    media.touch = true
  })

  it('offers Camera, Photos and Files on a touch screen', () => {
    render(
      <CapturePicker
        accept="image/jpeg,image/heic,application/pdf,.jpg,.pdf"
        onFiles={vi.fn()}
      />,
    )
    const camera = screen.getByLabelText('Camera') as HTMLInputElement
    const photos = screen.getByLabelText('Photos') as HTMLInputElement
    const files = screen.getByLabelText('Files') as HTMLInputElement
    expect(camera.type).toBe('file')
    expect(camera.getAttribute('capture')).toBe('environment')
    expect(camera.accept).toBe('image/*')
    expect(camera.multiple).toBe(false)
    // Images only, so Android opens its multi-select photo picker.
    expect(photos.multiple).toBe(true)
    expect(photos.accept).toBe('image/jpeg,image/heic')
    expect(photos.hasAttribute('capture')).toBe(false)
    expect(files.multiple).toBe(true)
    expect(files.accept).toBe('image/jpeg,image/heic,application/pdf,.jpg,.pdf')
    // The camera hint belongs to Camera alone.
    expect(files.hasAttribute('capture')).toBe(false)
  })

  it('falls back to any image before the limits load', () => {
    expect(photoAccept(undefined)).toBe('image/*')
    expect(photoAccept('.pdf,application/pdf')).toBe('image/*')
  })

  it('shows only Choose files, with a drop hint, on a computer', () => {
    media.touch = false
    render(<CapturePicker onFiles={vi.fn()} />)
    expect(screen.queryByLabelText('Camera')).toBeNull()
    expect(screen.queryByLabelText('Photos')).toBeNull()
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
    fireEvent.change(screen.getByLabelText('Files'), {
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
    expect(screen.getByLabelText('Files')).toBeDisabled()
  })
})
