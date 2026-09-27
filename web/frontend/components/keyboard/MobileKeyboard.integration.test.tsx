import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileKeyboard } from './MobileKeyboard'

describe('MobileKeyboard native utility controls', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('keeps Shift+Tab available without the custom typing keyboard', () => {
    const onSend = vi.fn()
    render(
      <MobileKeyboard
        onSend={onSend}
        sessionId="native-utility-test"
        onCompose={vi.fn().mockResolvedValue(true)}
        keyboardMode="native"
        connectionStatus="connected"
      />,
    )

    const shift = screen.getByRole('button', { name: 'Shift' })
    const tab = screen.getByRole('button', { name: 'Tab' })
    fireEvent.click(shift)
    fireEvent.click(tab)
    fireEvent.click(tab)

    expect(onSend.mock.calls).toEqual([['\x1b[Z'], ['\t']])
    expect(shift).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Show arrow keys' }))
    fireEvent.click(shift)
    fireEvent.click(screen.getByRole('button', { name: '←' }))
    expect(onSend).toHaveBeenLastCalledWith('\x1b[1;2D')
  })

  it('opens one compose field over the terminal, preserves its draft when collapsed, and sends once', async () => {
    const onCommit = vi.fn().mockResolvedValue(true)
    const onSend = vi.fn()
    render(
      <MobileKeyboard
        onSend={onSend}
        sessionId="native-overlay-test"
        onCompose={onCommit}
        keyboardMode="native"
        connectionStatus="connected"
      />,
    )

    const field = screen.getByLabelText('Compose') as HTMLTextAreaElement
    const overlay = field.closest('[hidden]') as HTMLElement
    expect(overlay).toHaveStyle({ display: 'none' })
    expect(screen.queryByText('Compose')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }))
    expect(overlay).not.toHaveAttribute('hidden')
    expect(field).toHaveFocus()

    fireEvent.change(field, { target: { value: 'please receive the file' } })
    expect(
      screen.getByRole('button', { name: /Hide keyboard, unsent draft/ }),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: /Hide keyboard, unsent draft/ }),
    )
    expect(overlay).toHaveStyle({ display: 'none' })
    expect(field).toHaveValue('please receive the file')
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: /Show keyboard, unsent draft/ }),
    )
    expect(field).toHaveFocus()
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(onCommit).toHaveBeenCalledWith(
        'native-overlay-test',
        'please receive the file',
        'send',
      )
      expect(field).toHaveValue('')
    })
  })

  it('hides the overlay before a terminal control acts', () => {
    const onSend = vi.fn()
    render(
      <MobileKeyboard
        onSend={onSend}
        sessionId="native-control-test"
        onCompose={vi.fn().mockResolvedValue(true)}
        keyboardMode="native"
        connectionStatus="connected"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }))
    const field = screen.getByLabelText('Compose') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }))

    expect(field.closest('[hidden]')).toHaveStyle({ display: 'none' })
    expect(onSend).toHaveBeenCalledWith('\t')
    expect(field).toHaveValue('draft')
  })

  it('restores the unsent badge after switching away from and back to a session', () => {
    const props = {
      onSend: vi.fn(),
      onCompose: vi.fn().mockResolvedValue(true),
      keyboardMode: 'native' as const,
      connectionStatus: 'connected' as const,
    }
    const view = render(<MobileKeyboard {...props} sessionId="saved-one" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }))
    fireEvent.change(screen.getByLabelText('Compose'), {
      target: { value: 'saved text' },
    })

    view.rerender(<MobileKeyboard {...props} sessionId="saved-two" />)
    expect(
      screen.getByRole('button', { name: 'Show keyboard' }),
    ).toBeInTheDocument()
    view.rerender(<MobileKeyboard {...props} sessionId="saved-one" />)
    expect(
      screen.getByRole('button', { name: 'Show keyboard, unsent draft' }),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show keyboard, unsent draft' }),
    )
    expect(screen.getByLabelText('Compose')).toHaveValue('saved text')
  })

  it('sends native Ctrl+C without inserting C into the draft', () => {
    const onSend = vi.fn()
    render(
      <MobileKeyboard
        onSend={onSend}
        sessionId="native-ctrl-test"
        onCompose={vi.fn().mockResolvedValue(true)}
        keyboardMode="native"
        connectionStatus="connected"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }))
    const field = screen.getByLabelText('Compose') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'CTRL' }))
    fireEvent.change(field, { target: { value: 'draftc' } })

    expect(onSend).toHaveBeenCalledExactlyOnceWith('\x03')
    expect(field).toHaveValue('draft')
    expect(screen.getByRole('button', { name: 'CTRL' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('does not interleave a terminal shortcut with a pending compose paste', async () => {
    let finish!: (success: boolean) => void
    const onCompose = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    const onSend = vi.fn()
    render(
      <MobileKeyboard
        onSend={onSend}
        sessionId="native-busy-test"
        onCompose={onCompose}
        keyboardMode="native"
        connectionStatus="connected"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }))
    const field = screen.getByLabelText('Compose') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'draft' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(field).toBeVisible()
    finish(false)
    await waitFor(() => expect(field).toHaveValue('draft'))
  })
})
