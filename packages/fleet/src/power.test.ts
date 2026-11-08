import { parseRow, view } from '@aico/status'
import { describe, expect, it } from 'vitest'
import {
  guestAction,
  guestPower,
  guestTask,
  listGuests,
  onbootOf,
  parseGuestPower,
  peerStatusRow,
  setGuestOnboot,
} from './power'
import type { PveRequest } from './proxmox'
import { PveError } from './proxmox'

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

/** A fake PVE: guests by id, their configs, and every request it was sent. */
function fakePve(
  configs: Record<number, Record<string, unknown> | Error>,
  writes: Error | null = null,
) {
  const sent: [string, string, Record<string, unknown> | undefined][] = []
  const call: PveRequest = async (method, path, body) => {
    sent.push([method, path, body])
    if (method === 'GET' && path === '/cluster/resources?type=vm')
      return [
        { type: 'lxc', vmid: 150, node: 'gem', name: 'hub', status: 'running' },
        { type: 'qemu', vmid: 180, node: 'gem', name: 'apps', status: 'stopped' },
        { type: 'lxc', vmid: 190, node: 'gem', name: 'aico', status: 'running' },
        { type: 'qemu', vmid: 200, node: 'gem', name: 'agent-work', status: 'stopped' },
      ]
    const config = /^\/nodes\/gem\/(?:qemu|lxc)\/(\d+)\/config$/.exec(path)
    if (method === 'GET' && config) {
      const found = configs[Number(config[1])]
      if (found instanceof Error) throw found
      return found
    }
    if (writes) throw writes
    return method === 'POST' ? 'UPID:gem:1' : null
  }
  return { call, sent }
}

describe('Proxmox through the API', () => {
  it('reads power for every named guest', async () => {
    const { call } = fakePve({})
    expect([...(await guestPower(call))]).toEqual([
      ['hub', 'running'],
      ['apps', 'stopped'],
      ['aico', 'running'],
      ['agent-work', 'stopped'],
    ])
  })
  it('lists guests with autostart from their configs; absent onboot is off', async () => {
    const { call } = fakePve({
      150: { onboot: 1 },
      180: { onboot: 0 },
      190: { onboot: '1' },
      200: { memory: 4096 },
    })
    expect((await listGuests(call)).map((g) => [g.vmid, g.onboot])).toEqual([
      [150, true],
      [180, false],
      [190, true],
      [200, false],
    ])
    expect(onbootOf({})).toBe(false)
  })
  it('shows an unreadable guest autostart as unknown, never off', async () => {
    const { call } = fakePve({
      150: { onboot: 1 },
      180: new PveError('Proxmox API refused the operation (HTTP 403)', 403),
      190: new Error('socket hang up'),
      200: { onboot: 0 },
    })
    const guests = await listGuests(call)
    expect(guests.map((g) => g.onboot)).toEqual([true, undefined, undefined, false])
  })
  it('fails the whole list when Proxmox cannot be read, never an empty healthy one', async () => {
    const call: PveRequest = async () => {
      throw new PveError('Proxmox API connection failed')
    }
    await expect(listGuests(call)).rejects.toThrow('connection failed')
    await expect(guestPower(call)).rejects.toThrow('connection failed')
  })
  it('sends power actions to the guest’s node and type, and reports a refusal', async () => {
    const { call, sent } = fakePve({})
    await guestAction(call, { vmid: 200, type: 'qemu', node: 'gem' }, 'start')
    await guestAction(call, { vmid: 150, type: 'lxc', node: 'gem' }, 'reboot')
    expect(sent).toEqual([
      ['POST', '/nodes/gem/qemu/200/status/start', undefined],
      ['POST', '/nodes/gem/lxc/150/status/reboot', undefined],
    ])
    const denied = fakePve({}, new PveError('Proxmox API refused the operation (HTTP 403)', 403))
    await expect(
      guestAction(denied.call, { vmid: 200, type: 'qemu', node: 'gem' }, 'shutdown'),
    ).rejects.toThrow('403')
    await expect(
      guestAction(call, { vmid: 200, type: 'qemu', node: 'gem' }, 'destroy' as never),
    ).rejects.toThrow('No guest action')
    await expect(
      guestAction(call, { vmid: 200, type: 'qemu', node: 'a/../b' }, 'start'),
    ).rejects.toThrow('node')
  })
  it('queues a hard stop and reads how a queued task ended', async () => {
    const { call, sent } = fakePve({})
    await guestAction(call, { vmid: 200, type: 'qemu', node: 'gem' }, 'stop')
    expect(sent).toEqual([['POST', '/nodes/gem/qemu/200/status/stop', undefined]])
    const task = 'UPID:gem:0001:0002:0003:qmshutdown:200:root@pam:'
    const path = `/nodes/gem/tasks/${encodeURIComponent(task)}/status`
    const status =
      (data: unknown): PveRequest =>
      async () =>
        data
    const guest = { node: 'gem' }
    expect(await guestTask(status({ status: 'running' }), guest, task)).toEqual({
      state: 'running',
    })
    expect(await guestTask(status({ status: 'stopped', exitstatus: 'OK' }), guest, task)).toEqual({
      state: 'ok',
    })
    expect(
      await guestTask(
        status({ status: 'stopped', exitstatus: 'VM quit/powerdown failed - got timeout' }),
        guest,
        task,
      ),
    ).toEqual({ state: 'failed', reason: 'VM quit/powerdown failed - got timeout' })
    const seen: string[] = []
    await guestTask(async (_m, p) => (seen.push(p), { status: 'running' }), guest, task)
    expect(seen).toEqual([path])
  })
  it('writes autostart as a config PUT and surfaces a refusal', async () => {
    const { call, sent } = fakePve({})
    await setGuestOnboot(call, { vmid: 180, type: 'qemu', node: 'gem' }, true)
    await setGuestOnboot(call, { vmid: 150, type: 'lxc', node: 'gem' }, false)
    expect(sent).toEqual([
      ['PUT', '/nodes/gem/qemu/180/config', { onboot: 1 }],
      ['PUT', '/nodes/gem/lxc/150/config', { onboot: 0 }],
    ])
    const denied = fakePve({}, new PveError('Proxmox API refused the operation (HTTP 403)', 403))
    await expect(
      setGuestOnboot(denied.call, { vmid: 180, type: 'qemu', node: 'gem' }, true),
    ).rejects.toThrow('403')
    await expect(setGuestOnboot(call, { vmid: 1, type: 'lxc', node: 'a;b' }, true)).rejects.toThrow(
      'node',
    )
  })
})
