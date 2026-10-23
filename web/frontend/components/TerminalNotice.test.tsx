import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionNotice, SizeHolderNotice } from './TerminalNotice'

describe('ConnectionNotice', () => {
  it('says it is connecting only before the first output', () => {
    const { rerender } = render(
      <ConnectionNotice status="connecting" hasConnected={false} />,
    )
    expect(screen.getByText('Connecting to the session')).toBeVisible()
    rerender(<ConnectionNotice status="connecting" hasConnected />)
    expect(screen.queryByTestId('terminal-notice')).toBeNull()
    rerender(<ConnectionNotice status="connected" hasConnected />)
    expect(screen.queryByTestId('terminal-notice')).toBeNull()
  })

  it('covers stale output after a dropped connection and offers Reconnect', () => {
    const onReconnect = vi.fn()
    render(
      <ConnectionNotice
        status="disconnected"
        hasConnected
        onReconnect={onReconnect}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'DisconnectedThis view stopped updating. The session keeps running.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('names a failed first connection', () => {
    render(<ConnectionNotice status="timeout" hasConnected={false} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Timed outCouldn’t reach the session.',
    )
  })

  it('says the session ended and offers a new one', () => {
    const onNewSession = vi.fn()
    render(
      <ConnectionNotice
        status="session_dead"
        hasConnected
        onNewSession={onNewSession}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Session ended')
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNewSession).toHaveBeenCalledOnce()
  })
})

describe('SizeHolderNotice', () => {
  it('names the holder and takes the size back', () => {
    const onUseHere = vi.fn()
    render(
      <SizeHolderNotice holder="Aico desktop" onUseHere={onUseHere} isMobile />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Viewing on Aico desktop',
    )
    expect(screen.getByRole('status')).toHaveTextContent('this phone')
    fireEvent.click(screen.getByRole('button', { name: 'Use here' }))
    expect(onUseHere).toHaveBeenCalledOnce()
  })
})
