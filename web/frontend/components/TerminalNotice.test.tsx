import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionModelSwitch } from '@/lib/hooks/use-terminal-sessions'
import {
  ConnectionNotice,
  HostNotice,
  ModelSwitchNotice,
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
      <SizeHolderNotice
        holder="Chrome on Linux"
        onUseHere={onUseHere}
        isMobile
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sized for Chrome on Linux',
    )
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

describe('ModelSwitchNotice', () => {
  const REFUSAL: SessionModelSwitch = {
    key: 'k1',
    kind: 'refusal',
    from: 'claude-opus-5-5',
    to: 'claude-opus-4-8',
    category: 'cyber',
    at: 1,
    stopped: true,
    commit: 'e5a9695',
    worktree_changed: null,
    checked: true,
    rewind_to: '11111111-1111-4111-8111-111111111111',
  }

  it('says a refusal switched the model and stopped the turn, with the facts on request', () => {
    render(<ModelSwitchNotice change={REFUSAL} />)
    const notice = screen.getByTestId('model-switch-notice')
    expect(notice).toHaveClass('warn')
    expect(
      screen.getByText(
        'Switched to claude-opus-4-8 after a cyber refusal · stopped',
      ),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Was claude-opus-5-5. Last commit e5a9695. Changed since: unknown. Rewind it, or relaunch from a handoff.',
      ),
    ).not.toBeVisible()
    fireEvent.click(screen.getByText('Details'))
    expect(screen.getByText(/^Was claude-opus-5-5\./)).toBeVisible()
    expect(notice.textContent).not.toMatch(/terminal|A-Term/i)
  })

  it.each([
    [
      { kind: 'refusal', stopped: false, category: 'abuse', commit: null },
      'Switched to claude-opus-4-8 after an abuse refusal · not stopped',
      'warn',
    ],
    [
      { kind: 'substituted', category: null },
      'Served claude-opus-4-8 instead of claude-opus-5-5 · stopped',
      'warn',
    ],
    [
      { kind: 'paused', to: 'claude-opus-5-5' },
      'Stopped on a cyber refusal · waiting on you',
      'warn',
    ],
    [
      { kind: 'paused', to: 'claude-opus-5-5', category: null },
      'Stopped on a refusal · waiting on you',
      'warn',
    ],
    [
      { kind: 'changed', category: null, stopped: false },
      'Now on claude-opus-4-8 (was claude-opus-5-5)',
      'quiet',
    ],
  ] as const)('words %o as %s', (fields, text, tone) => {
    render(<ModelSwitchNotice change={{ ...REFUSAL, ...fields }} />)
    expect(screen.getByRole('status')).toHaveTextContent(text)
    expect(screen.getByTestId('model-switch-notice')).toHaveClass(tone)
  })

  it.each([
    [
      { checked: false, commit: null },
      'Was claude-opus-5-5. Last commit and changes not checked yet. Rewind it, or relaunch from a handoff.',
    ],
    [
      { rewind_to: null, worktree_changed: true },
      'Was claude-opus-5-5. Last commit e5a9695. Changed since: yes. No rewind for this session: relaunch from a handoff.',
    ],
  ] as const)('gives the facts and the way back for %o', (fields, detail) => {
    render(<ModelSwitchNotice change={{ ...REFUSAL, ...fields }} />)
    expect(screen.getByText(detail)).toBeInTheDocument()
  })

  it('offers details only for a refusal fallback', () => {
    render(<ModelSwitchNotice change={{ ...REFUSAL, kind: 'substituted' }} />)
    expect(screen.queryByText('Details')).toBeNull()
  })
})
