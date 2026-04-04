import { describe, expect, it } from 'vitest'
import {
  getMobileTerminalBannerState,
  isReconnectableStatus,
} from './mobile-terminal-status'

describe('mobile-terminal-status', () => {
  it('marks disconnected states as reconnectable', () => {
    expect(isReconnectableStatus('disconnected')).toBe(true)
    expect(isReconnectableStatus('error')).toBe(true)
    expect(isReconnectableStatus('timeout')).toBe(true)
    expect(isReconnectableStatus('connecting')).toBe(false)
    expect(isReconnectableStatus('session_dead')).toBe(false)
    expect(isReconnectableStatus(undefined)).toBe(false)
  })

  it('describes a live shell session by default', () => {
    expect(
      getMobileTerminalBannerState({
        connectionStatus: 'connected',
      }),
    ).toEqual({
      label: 'Live',
      detail: 'Shell',
      tone: 'success',
    })
  })

  it('surfaces voice state above generic connected copy', () => {
    expect(
      getMobileTerminalBannerState({
        connectionStatus: 'connected',
        activeMode: 'claude',
        voiceActive: true,
      }),
    ).toEqual({
      label: 'Voice active',
      detail: 'Agent input is using the mic',
      tone: 'success',
    })
  })

  it('describes minimized keyboard state for active sessions', () => {
    expect(
      getMobileTerminalBannerState({
        connectionStatus: 'connected',
        activeMode: 'shell',
        minimized: true,
      }),
    ).toEqual({
      label: 'Live',
      detail: 'Keyboard hidden',
      tone: 'neutral',
    })
  })

  it('adds a reconnect action only for reconnectable failures', () => {
    expect(
      getMobileTerminalBannerState({
        connectionStatus: 'disconnected',
        canReconnect: true,
      }),
    ).toEqual({
      label: 'Disconnected',
      detail: 'Reconnect to resume this terminal',
      tone: 'danger',
      actionLabel: 'Reconnect',
    })

    expect(
      getMobileTerminalBannerState({
        connectionStatus: 'session_dead',
        canReconnect: true,
      }),
    ).toEqual({
      label: 'Session ended',
      detail: 'Open or reset a pane to continue',
      tone: 'warning',
    })
  })
})
