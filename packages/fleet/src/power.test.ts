import { parseRow, view } from '@aico/status'
import { describe, expect, it } from 'vitest'
import { parseGuestPower, peerStatusRow } from './power'

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
