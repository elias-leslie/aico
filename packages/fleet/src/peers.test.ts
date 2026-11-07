import { describe, expect, it } from 'vitest'
import { fullPeers } from './peers'
import type { FleetSettings } from './settings'

const endpoint = { address: '192.168.1.2', port: 7449 }
const settings = (extra: Partial<FleetSettings> = {}) =>
  ({
    machine: 'home',
    peerRoot: '/run/aico/fleet',
    peers: [
      { name: 'gem', endpoint },
      { name: 'box', endpoint, hardware: 'tower' },
      { name: 'agent', endpoint },
    ],
    ...extra,
  }) as FleetSettings
const pin = (name: string, role: 'full' | 'worker') => ({ name, publicKey: '', role })

describe('fullPeers', () => {
  const pins = [pin('home', 'full'), pin('gem', 'full'), pin('box', 'full'), pin('agent', 'worker')]
  it('lists only full peers and leaves workers out', () => {
    const found = fullPeers(settings(), pins)
    expect(found.role).toBe('full')
    expect(found.peers.map((p) => p.name)).toEqual(['gem', 'box'])
    expect(found.peers[0]?.exec).toBe('/run/aico/fleet/gem/exec.sock')
  })
  it("sets aside a peer labelled with this machine's own computer", () => {
    const found = fullPeers(settings({ hardware: 'tower' }), pins)
    expect(found.peers.map((p) => p.name)).toEqual(['gem'])
    expect(found.sameComputer).toEqual(['box'])
  })
  it('reports a worker or unlisted machine by its role', () => {
    expect(fullPeers(settings(), [pin('home', 'worker')]).role).toBe('worker')
    expect(fullPeers(settings(), []).role).toBeNull()
  })
})
