import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NativeKeyboardInput } from './NativeKeyboardInput'

describe('NativeKeyboardInput', () => {
  it('keeps the compose field focused when Insert or Send is tapped', () => {
    render(
      <NativeKeyboardInput
        sessionId="focus"
        connected
        onCommit={vi.fn().mockResolvedValue(true)}
      />,
    )
    const input = screen.getByLabelText('Compose') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'draft' } })
    input.focus()

    for (const name of ['Insert', 'Send']) {
      expect(fireEvent.pointerDown(screen.getByRole('button', { name }))).toBe(
        false,
      )
      expect(document.activeElement).toBe(input)
    }
  })

  it('keeps autocorrect and middle edits local until Insert', async () => {
    const onCommit = vi.fn().mockResolvedValue(true)
    render(
      <NativeKeyboardInput
        sessionId="correction"
        connected
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Compose') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'hte ' } })
    fireEvent.change(input, { target: { value: 'the ' } })
    fireEvent.change(input, { target: { value: 'the wrold' } })
    // Selecting the middle of a line and replacing it changes only the draft.
    fireEvent.change(input, { target: { value: 'the world' } })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(
        'correction',
        'the world',
        'insert',
      ),
    )
    expect(input.value).toBe('')
  })

  it('sends final text once only through explicit Send', async () => {
    const onCommit = vi.fn().mockResolvedValue(true)
    render(
      <NativeKeyboardInput
        sessionId="send-once"
        connected
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Compose') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hte ' } })
    fireEvent.change(input, { target: { value: 'the ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(
        'send-once',
        'the ',
        'send',
      ),
    )
    expect(input.value).toBe('')
  })

  it('preserves a draft across disconnect and session switches', async () => {
    const onCommit = vi.fn().mockResolvedValue(true)
    const { rerender } = render(
      <NativeKeyboardInput
        key="one"
        sessionId="one"
        connected
        onCommit={onCommit}
      />,
    )
    fireEvent.change(screen.getByLabelText('Compose'), {
      target: { value: 'my draft' },
    })
    rerender(
      <NativeKeyboardInput
        key="one"
        sessionId="one"
        connected={false}
        onCommit={onCommit}
      />,
    )
    expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled()
    rerender(
      <NativeKeyboardInput
        key="two"
        sessionId="two"
        connected
        onCommit={onCommit}
      />,
    )
    expect((screen.getByLabelText('Compose') as HTMLInputElement).value).toBe(
      '',
    )
    rerender(
      <NativeKeyboardInput
        key="one"
        sessionId="one"
        connected
        onCommit={onCommit}
      />,
    )
    expect((screen.getByLabelText('Compose') as HTMLInputElement).value).toBe(
      'my draft',
    )
  })

  it('does not commit during IME composition and keeps failed drafts', async () => {
    const onCommit = vi.fn().mockResolvedValue(false)
    render(
      <NativeKeyboardInput sessionId="ime" connected onCommit={onCommit} />,
    )
    const input = screen.getByLabelText('Compose') as HTMLInputElement
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'typed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    expect(input.value).toBe('typed')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your draft is still here',
    )
  })
})
