import { describe, expect, it } from 'vitest'
import { hostNoticeCopy } from './host-notice'

describe('hostNoticeCopy', () => {
  it('covers the terminal only while the host cannot be reached', () => {
    expect(hostNoticeCopy('agent-work', 'live')).toBeNull()
    expect(hostNoticeCopy('agent-work', 'something-new')).toBeNull()
    for (const state of [
      'connecting',
      'offline',
      'powered_off',
      'identity_changed',
      'disconnected',
      'refused',
    ])
      expect(hostNoticeCopy('agent-work', state)?.title).toContain('agent-work')
  })

  it('offers Reconnect where trying again can help', () => {
    expect(hostNoticeCopy('w', 'offline')?.reconnect).toBe(true)
    expect(hostNoticeCopy('w', 'disconnected')?.reconnect).toBe(true)
    expect(hostNoticeCopy('w', 'refused')?.reconnect).toBe(true)
    expect(hostNoticeCopy('w', 'connecting')?.reconnect).toBe(false)
    expect(hostNoticeCopy('w', 'identity_changed')?.reconnect).toBe(false)
    expect(hostNoticeCopy('w', 'offline')?.powerOn).toBe(false)
  })

  it('offers Power on, not Reconnect, for a host that is powered off', () => {
    expect(hostNoticeCopy('agent-work', 'powered_off')).toEqual({
      title: 'agent-work is powered off',
      detail: 'Power it on to get back to this session.',
      reconnect: false,
      powerOn: true,
    })
  })
})
