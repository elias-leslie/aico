import { describe, expect, it } from 'vitest'
import type { Runner } from './sh'
import { listLines, snapshotName, vm } from './vm'

const guests = [
  {
    vmid: 180,
    name: 'apps',
    type: 'qemu',
    status: 'stopped',
    pool: 'summitflow-ops',
    node: 'pve',
    maxmem: 6442450944,
    maxdisk: 68182605824,
  },
  {
    vmid: 100,
    name: 'st-browser',
    type: 'qemu',
    status: 'running',
    pool: 'summitflow',
    node: 'pve',
    maxmem: 8589934592,
    maxdisk: 107374182400,
  },
  {
    vmid: 150,
    name: 'hub',
    type: 'lxc',
    status: 'running',
    pool: 'summitflow-ops',
    node: 'pve',
    maxmem: 1073741824,
    maxdisk: 1,
  },
  { vmid: 190, name: 'aico', type: 'lxc', status: 'running', node: 'pve', maxmem: 1, maxdisk: 1 },
]

// A stub PVE host: records the remote commands and answers the resource and status queries.
function host() {
  const remote: string[] = []
  const run: Runner = (cmd, args) => {
    if (cmd !== 'ssh') return { code: 0, out: 'declared', err: '' }
    const command = args.at(-1) as string
    remote.push(command)
    if (command.startsWith('pvesh get /cluster/resources'))
      return { code: 0, out: JSON.stringify(guests), err: '' }
    if (command.includes('/status/current'))
      return {
        code: 0,
        out: JSON.stringify({
          vmid: 100,
          name: 'st-browser',
          status: 'running',
          cpu: 0.123,
          mem: 2147483648,
          maxmem: 8589934592,
          uptime: 42,
        }),
        err: '',
      }
    return { code: 0, out: '', err: '' }
  }
  const out: string[] = []
  const err: string[] = []
  return {
    remote,
    out,
    err,
    call: (...argv: string[]) =>
      vm(
        argv,
        run,
        (l) => out.push(l),
        (l) => err.push(l),
      ),
  }
}

describe('aico vm', () => {
  it('lists guests sorted by id in st vm format', () => {
    const lines = listLines(
      [...guests]
        .sort((a, b) => a.vmid - b.vmid)
        .map((g) => ({ ...g, type: g.type as 'qemu', pool: g.pool ?? null })),
    )
    expect(lines[2]).toBe('100    st-browser                running    8192MB   100GB   ')
    expect(lines.length).toBe(6)
  })

  it('status prints the line hosts.json power checks read', () => {
    const h = host()
    expect(h.call('status', '100')).toBe(0)
    expect(h.remote.at(-1)).toBe(
      'pvesh get /nodes/pve/qemu/100/status/current --output-format json',
    )
    expect(h.out).toEqual([
      'VM 100 (st-browser): running | CPU: 12% | RAM: 2048MB/8192MB | Uptime: 42s',
    ])
  })

  it('maps power and snapshots to qm or pct, only inside the allowed pools', () => {
    const h = host()
    expect(h.call('stop', '100')).toBe(0)
    expect(h.call('start', '150')).toBe(0)
    expect(h.call('snapshot', '100', 'before-x')).toBe(0)
    expect(h.remote.filter((c) => !c.startsWith('pvesh'))).toEqual([
      'qm stop 100',
      'pct start 150',
      "qm snapshot 100 before-x --description 'Auto-snapshot " +
        h.remote.at(-1)?.split("'Auto-snapshot ")[1],
    ])
    expect(() => h.call('start', '190')).toThrow(/pool none/)
    expect(() => h.call('snapshot', '180')).toThrow(/allowed only for pools summitflow$/)
    expect(() => h.call('snapshot', '100', 'bad name')).toThrow(/Snapshot names/)
    expect(() => h.call('status', '12')).toThrow(/VM IDs/)
    expect(h.call('destroy', '100')).toBe(2)
  })

  it('names snapshots like st vm', () => {
    expect(snapshotName(new Date('2026-11-04T13:05:09Z'))).toBe('snap-20261104-130509')
  })
})
