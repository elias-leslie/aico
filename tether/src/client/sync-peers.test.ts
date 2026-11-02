import { describe, expect, it } from 'vitest'
import { parseHosts, peerDir } from '../hub/hosts'
import { hostsFile, syncPeers } from './sync-peers'

const ENTRY = { ssh: 'gem', socket: '/run/user/1000/tether/default/control.sock' }
const ENV = { XDG_RUNTIME_DIR: '/run/user/7' }

describe('sync peers', () => {
  it('lists the hosts that have a sync socket, at their link directory', () => {
    const text = JSON.stringify([
      { ...ENTRY, name: 'gem', sync: '/run/user/1000/aico/sync.sock' },
      { ...ENTRY, name: 'agent-work' },
      { ...ENTRY, name: 'bad', sync: 'relative.sock' },
      { ...ENTRY, name: 'gem', sync: '/run/user/1000/aico/other.sock' },
    ])
    expect(syncPeers(text, ENV, 7)).toEqual([
      { name: 'gem', socket: '/run/user/7/tether/peers/gem/sync.sock' },
    ])
  })

  it('reads the same peer directory and names as the daemon registry', () => {
    const text = JSON.stringify([
      { ...ENTRY, name: 'a', sync: '/s/a.sock' },
      { ...ENTRY, name: 'b', sync: '/s/b.sock' },
      { ...ENTRY, name: 'c' },
    ])
    const daemon = parseHosts(text)
      .hosts.filter((host) => host.sync)
      .map((host) => ({ name: host.name, socket: `${peerDir(ENV, 7, host.name)}/sync.sock` }))
    expect(syncPeers(text, ENV, 7)).toEqual(daemon)
  })

  it('treats unreadable text as no peers, and finds the file like the daemon', () => {
    expect(syncPeers('{', ENV, 7)).toEqual([])
    expect(syncPeers('{}', ENV, 7)).toEqual([])
    expect(hostsFile({ HOME: '/home/u' }, '/h')).toBe('/home/u/.config/tether/hosts.json')
    expect(hostsFile({ TETHER_HOSTS_FILE: '/t/h.json' }, '/h')).toBe('/t/h.json')
  })
})
