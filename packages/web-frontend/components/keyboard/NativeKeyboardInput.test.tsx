import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NativeKeyboardInput } from './NativeKeyboardInput'

describe('NativeKeyboardInput', () => {
  it('keeps an unsent draft through an app reload and forgets it once sent', async () => {
    window.localStorage.clear()
    const typed = render(
      <NativeKeyboardInput
        keepOnDevice
        sessionId="reload"
        connected
        onCommit={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText('Compose'), {
      target: { value: 'half a thought' },
    })
    typed.unmount()

    // A reload: this module's memory is gone, the device's isn't.
    vi.resetModules()
    const reloaded = await import('./NativeKeyboardInput')
    const onCommit = vi.fn().mockResolvedValue(true)
    render(
      <reloaded.NativeKeyboardInput
        keepOnDevice
        sessionId="reload"
        connected
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Compose') as HTMLInputElement
    expect(input.value).toBe('half a thought')

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(input.value).toBe(''))
    expect(window.localStorage.getItem('a-term-compose:reload')).toBeNull()
  })

  it('still works when the browser refuses storage', () => {
    const refused = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('no room')
      })
    render(
      <NativeKeyboardInput
        keepOnDevice
        sessionId="private"
        connected
        onCommit={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('Compose') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'kept here' } })
    expect(input.value).toBe('kept here')
    refused.mockRestore()
  })

  it('keeps the compose field focused when Insert or Send is tapped', () => {
    render(
      <NativeKeyboardInput
        keepOnDevice
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
        keepOnDevice
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
        keepOnDevice
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
        keepOnDevice
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
        keepOnDevice
        key="one"
        sessionId="one"
        connected={false}
        onCommit={onCommit}
      />,
    )
    expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled()
    rerender(
      <NativeKeyboardInput
        keepOnDevice
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
        keepOnDevice
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
      <NativeKeyboardInput
        keepOnDevice
        sessionId="ime"
        connected
        onCommit={onCommit}
      />,
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
      'Insert was interrupted. Check the session before retrying; your draft is saved.',
    )
  })

  it('keeps a shell session draft off the device', () => {
    const { container } = render(
      <NativeKeyboardInput
        sessionId="shell"
        keepOnDevice={false}
        connected
        onCommit={vi.fn()}
      />,
    )
    const input = container.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a password' } })
    expect(window.localStorage.getItem('a-term-compose:shell')).toBeNull()
    expect(input.value).toBe('a password')
  })
})
