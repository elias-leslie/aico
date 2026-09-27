import { fireEvent, render, screen } from '@testing-library/react'
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
})
