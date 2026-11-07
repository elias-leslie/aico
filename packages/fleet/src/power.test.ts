import { parseRow, view } from '@aico/status'
import { describe, expect, it } from 'vitest'
import { guestOnbootArgs, parseGuestPower, parseOnboot, peerStatusRow } from './power'

const settings = { machine: 'workstation', deadMs: 5000 }
const peer = { name: 'worker', connected: false, lastSeen: null }
describe('fleet peer power status', () => {
  it('posts a valid stopped guest as off and never counts it late', () => {
    const row = peerStatusRow(settings, peer, 'worker', 'stopped', 1000)
    expect(row).toMatchObject({
      state: 'off',
      meaning: 'worker is off. Its link will connect when it starts.',
    })
    const parsed = parseRow(row)
    const shown = view([{ row: parsed, updatedAt: 1000 }], 1_000_000)
    expect(shown.rows[0].shown).toBe('off')
    expect(shown.summary.problems).toBe(0)
  })
  it('keeps running, unknown and unapproved disconnected peers as problems', () => {
    for (const power of ['running', undefined]) {
      expect(peerStatusRow(settings, peer, 'worker', power, 1000).state).toBe('warn')
    }
    expect(peerStatusRow(settings, peer, undefined, 'stopped', 1000).state).toBe('warn')
  })
  it('trusts a live link over a racing power reading', () => {
    expect(
      peerStatusRow(settings, { ...peer, connected: true }, 'worker', 'stopped', 1000).state,
    ).toBe('ok')
  })
  it('reads only actual guest power states and rejects ambiguous names', () => {
    const rows = [
      { type: 'qemu', name: 'worker', status: 'stopped' },
      { type: 'lxc', name: 'container', status: 'running' },
      { type: 'qemu', name: 'bad', status: 'unknown' },
      { type: 'node', name: 'node', status: 'stopped' },
    ]
    expect([...parseGuestPower(rows)]).toEqual([
      ['worker', 'stopped'],
      ['container', 'running'],
    ])
    expect(parseGuestPower([...rows, rows[0]]).has('worker')).toBe(false)
    expect(() => parseGuestPower({})).toThrow()
  })
})

describe('Proxmox start-at-boot', () => {
  it('reads onboot from the configs and leaves out guests that do not say', () => {
    const boot = parseOnboot(
      [
        '/etc/pve/nodes/gem/qemu-server/180.conf: onboot: 0',
        '/etc/pve/nodes/gem/lxc/150.conf: onboot: 1',
        'noise',
        '/etc/pve/nodes/gem/lxc/x.conf: onboot: 1',
      ].join('\n'),
    )
    expect([...boot]).toEqual([
      [180, false],
      [150, true],
    ])
  })
  it('writes it with pvesh on the guest’s own node and type, and refuses a bad node', () => {
    expect(guestOnbootArgs({ vmid: 180, type: 'qemu', node: 'gem' }, true)).toEqual([
      'pvesh',
      'set',
      '/nodes/gem/qemu/180/config',
      '--onboot',
      '1',
    ])
    expect(guestOnbootArgs({ vmid: 150, type: 'lxc', node: 'gem' }, false).slice(2)).toEqual([
      '/nodes/gem/lxc/150/config',
      '--onboot',
      '0',
    ])
    expect(() => guestOnbootArgs({ vmid: 1, type: 'lxc', node: 'a;b' }, true)).toThrow()
  })
})
