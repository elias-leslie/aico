import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ConnectionNotice,
  HostNotice,
  SizeHolderNotice,
} from './TerminalNotice'

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

describe('HostNotice', () => {
  it('names the host and why, with Reconnect only where it helps', () => {
    const onReconnect = vi.fn()
    const { rerender } = render(
      <HostNotice
        away={{ host: 'agent-work', state: 'offline' }}
        onReconnect={onReconnect}
      />,
    )
    expect(screen.getByText('agent-work is offline')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
    rerender(
      <HostNotice
        away={{ host: 'agent-work', state: 'identity_changed' }}
        onReconnect={onReconnect}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    rerender(
      <HostNotice
        away={{ host: 'agent-work', state: 'live' }}
        onReconnect={onReconnect}
      />,
    )
    expect(screen.queryByTestId('host-notice')).toBeNull()
  })

  it('offers Power on for a host that is off, and says why it did not start', async () => {
    let fail: (error: Error) => void = () => {}
    const onPowerOn = vi.fn(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    const onReconnect = vi.fn()
    const { rerender } = render(
      <HostNotice
        away={{ host: 'agent-work', state: 'powered_off' }}
        onReconnect={onReconnect}
        onPowerOn={onPowerOn}
      />,
    )
    expect(screen.getByText('agent-work is powered off')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Power on' }))
    expect(onPowerOn).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Powering on…' })).toBeDisabled()
    await act(async () => fail(new Error('hosts.json has no wake command')))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'hosts.json has no wake command',
    )
    expect(screen.getByRole('button', { name: 'Power on' })).toBeEnabled()
    // Once the host is coming up, the notice says so.
    rerender(
      <HostNotice
        away={{ host: 'agent-work', state: 'connecting' }}
        onReconnect={onReconnect}
        onPowerOn={onPowerOn}
      />,
    )
    expect(screen.getByText('Connecting to agent-work…')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Power on' })).toBeNull()
  })
})
