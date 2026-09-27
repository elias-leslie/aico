import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NativeKeyboardInput } from './NativeKeyboardInput'

describe('NativeKeyboardInput', () => {
  it('renders a one-row mobile overlay without a visible Compose label', () => {
    const { container } = render(
      <NativeKeyboardInput
        sessionId="mobile-layout"
        connected
        mobileOverlay
        onCommit={vi.fn().mockResolvedValue(true)}
      />,
    )
    const field = screen.getByRole('textbox', { name: 'Compose' })
    expect(field.tagName).toBe('TEXTAREA')
    expect(field).toHaveAttribute('rows', '1')
    expect(field).toHaveAttribute('enterkeyhint', 'send')
    expect(container.querySelector('label')).toBeNull()
    expect(
      screen.getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['Send'])
    expect(container.firstElementChild).toHaveClass('absolute', 'bottom-full')
  })

  it('grows with wrapping up to a scrollable maximum', () => {
    let measuredHeight = 38
    const scrollHeight = vi
      .spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(() => measuredHeight)
    try {
      render(
        <NativeKeyboardInput
          sessionId="mobile-grow"
          connected
          mobileOverlay
          onCommit={vi.fn().mockResolvedValue(true)}
        />,
      )
      const field = screen.getByRole('textbox', { name: 'Compose' })
      fireEvent.change(field, { target: { value: 'short draft' } })
      expect(field).toHaveStyle({ height: '38px', overflowY: 'hidden' })

      measuredHeight = 180
      fireEvent.change(field, { target: { value: 'a long wrapped draft' } })
      expect(field).toHaveStyle({ height: '120px', overflowY: 'auto' })
    } finally {
      scrollHeight.mockRestore()
    }
  })

  it('hides and reopens the overlay without losing its draft', () => {
    const onDraftPresenceChange = vi.fn()
    const onCommit = vi.fn().mockResolvedValue(true)
    const { rerender, container } = render(
      <NativeKeyboardInput
        sessionId="mobile-hidden"
        connected
        mobileOverlay
        visible
        onCommit={onCommit}
        onDraftPresenceChange={onDraftPresenceChange}
      />,
    )
    expect(onDraftPresenceChange).toHaveBeenLastCalledWith(false)
    fireEvent.change(screen.getByRole('textbox', { name: 'Compose' }), {
      target: { value: 'saved draft' },
    })
    expect(onDraftPresenceChange).toHaveBeenLastCalledWith(true)
    rerender(
      <NativeKeyboardInput
        sessionId="mobile-hidden"
        connected
        mobileOverlay
        visible={false}
        onCommit={onCommit}
        onDraftPresenceChange={onDraftPresenceChange}
      />,
    )
    expect(container.firstElementChild).toHaveAttribute('hidden')
    expect(screen.queryByRole('textbox', { name: 'Compose' })).toBeNull()
    rerender(
      <NativeKeyboardInput
        sessionId="mobile-hidden"
        connected
        mobileOverlay
        visible
        onCommit={onCommit}
        onDraftPresenceChange={onDraftPresenceChange}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Compose' })).toHaveValue(
      'saved draft',
    )
  })

  it('sends the current DOM value on deliberate Enter and ignores IME Enter', async () => {
    const onCommit = vi.fn().mockResolvedValue(true)
    const onDraftPresenceChange = vi.fn()
    render(
      <NativeKeyboardInput
        sessionId="mobile-enter"
        connected
        mobileOverlay
        onCommit={onCommit}
        onDraftPresenceChange={onDraftPresenceChange}
      />,
    )
    const field = screen.getByRole('textbox', {
      name: 'Compose',
    }) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'draft' } })
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(onCommit).not.toHaveBeenCalled()

    // The browser can apply a final autocorrect replacement before React's change event.
    field.value = 'corrected draft'
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false)
    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(
        'mobile-enter',
        'corrected draft',
        'send',
      ),
    )
    expect(field).toHaveValue('')
    await waitFor(() =>
      expect(onDraftPresenceChange).toHaveBeenLastCalledWith(false),
    )
  })

  it('commits once for repeated mobile submission and retains a failed draft', async () => {
    let resolveCommit: (success: boolean) => void = () => {}
    const onCommit = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCommit = resolve
        }),
    )
    render(
      <NativeKeyboardInput
        sessionId="mobile-failed"
        connected
        mobileOverlay
        onCommit={onCommit}
      />,
    )
    const field = screen.getByRole('textbox', { name: 'Compose' })
    fireEvent.change(field, { target: { value: 'keep me' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    resolveCommit(false)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Your draft is still here',
      ),
    )
    expect(field).toHaveValue('keep me')
  })

  it('retains a last-moment DOM autocorrection when delivery fails', async () => {
    const onCommit = vi.fn().mockResolvedValue(false)
    render(
      <NativeKeyboardInput
        sessionId="mobile-last-correction"
        connected
        mobileOverlay
        onCommit={onCommit}
      />,
    )
    const field = screen.getByRole('textbox', {
      name: 'Compose',
    }) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'teh file' } })
    field.value = 'the file'
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith(
        'mobile-last-correction',
        'the file',
        'send',
      ),
    )
    expect(field).toHaveValue('the file')
  })

  it('routes a native Ctrl letter to the terminal without changing the draft', () => {
    const onCtrlLetter = vi.fn()
    const onCtrlCancel = vi.fn()
    const { rerender } = render(
      <NativeKeyboardInput
        sessionId="mobile-ctrl"
        connected
        mobileOverlay
        ctrlActive
        onCtrlLetter={onCtrlLetter}
        onCtrlCancel={onCtrlCancel}
        onCommit={vi.fn().mockResolvedValue(true)}
      />,
    )
    const field = screen.getByRole('textbox', {
      name: 'Compose',
    }) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'draft' } })
    expect(onCtrlCancel).toHaveBeenCalledTimes(1)

    rerender(
      <NativeKeyboardInput
        sessionId="mobile-ctrl"
        connected
        mobileOverlay
        ctrlActive
        onCtrlLetter={onCtrlLetter}
        onCtrlCancel={onCtrlCancel}
        onCommit={vi.fn().mockResolvedValue(true)}
      />,
    )
    expect(fireEvent.keyDown(field, { key: 'c' })).toBe(false)
    expect(onCtrlLetter).toHaveBeenCalledWith('c')
    expect(field).toHaveValue('draft')

    fireEvent.change(field, { target: { value: 'draftd' } })
    expect(onCtrlLetter).toHaveBeenLastCalledWith('d')
    expect(field).toHaveValue('draft')
  })

  it('explains why a pasted multiline draft cannot be sent', () => {
    render(
      <NativeKeyboardInput
        sessionId="mobile-multiline"
        connected
        mobileOverlay
        onCommit={vi.fn().mockResolvedValue(true)}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Compose' }), {
      target: { value: 'one\ntwo' },
    })
    expect(
      screen.getByText('Remove line breaks to send this draft.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

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
