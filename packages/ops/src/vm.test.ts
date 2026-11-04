import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Refusal } from './deploy'
import type { Runner } from './sh'
import { guestRows, labUse, listLines, routeOp, snapshotName, summitflowIdentity, vm } from './vm'

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

// A stub of SummitFlow's /api/vm/op: the token's pools are Proxmox's to enforce, so the stub refuses
// power outside them the way the backend passes on PVE's 403 (HTTP 400 with the PVE message).
function backend() {
  const posts: {
    op: string
    vmid: string | null
    args: Record<string, unknown>
    headers: Record<string, string>
  }[] = []
  const tokenPools = ['summitflow', 'summitflow-ops']
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    posts.push({ ...body, headers: init.headers as Record<string, string> })
    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (body.op === 'list_vms') return reply(200, { result: guests })
    if (body.op === 'status')
      return reply(200, {
        result: {
          vmid: 100,
          name: 'st-browser',
          status: 'running',
          cpu: 0.123,
          mem: 2147483648,
          maxmem: 8589934592,
          uptime: 42,
        },
      })
    const guest = guests.find((g) => String(g.vmid) === body.vmid)
    if (!guest?.pool || !tokenPools.includes(guest.pool))
      return reply(400, {
        detail: `Proxmox API error 403: Permission check failed (/vms/${body.vmid}, VM.PowerMgmt)`,
      })
    return reply(200, { result: null })
  }) as unknown as typeof fetch
  return { posts, fetcher }
}

function harness(env: NodeJS.ProcessEnv = {}) {
  const b = backend()
  const ran: string[] = []
  const run: Runner = (cmd, args) => {
    ran.push([cmd, ...args].join(' '))
    return { code: 0, out: 'declared', err: '' }
  }
  const out: string[] = []
  const err: string[] = []
  const call = routeOp({ ST_API_BASE: 'http://127.0.0.1:9/api', ...env }, b.fetcher)
  return {
    ...b,
    ran,
    out,
    err,
    run: (...argv: string[]) =>
      vm(
        argv,
        call,
        run,
        (l) => out.push(l),
        (l) => err.push(l),
      ),
  }
}

describe('aico vm', () => {
  it('lists guests sorted by id in st vm format', async () => {
    const h = harness()
    expect(await h.run('list')).toBe(0)
    expect(h.out[2]).toBe('100    st-browser                running    8192MB   100GB   ')
    expect(h.out.length).toBe(6)
    expect(h.posts[0]).toMatchObject({ op: 'list_vms', vmid: null })
    expect(listLines(guestRows(guests)).length).toBe(6)
  })

  it('status prints the line hosts.json power checks read', async () => {
    const h = harness()
    expect(await h.run('status', '100')).toBe(0)
    expect(h.posts.at(-1)).toMatchObject({ op: 'status', vmid: '100', args: {} })
    expect(h.out).toEqual([
      'VM 100 (st-browser): running | CPU: 12% | RAM: 2048MB/8192MB | Uptime: 42s',
    ])
  })

  it('power and snapshots go to the route; a VM outside the token pools is refused by Proxmox', async () => {
    const h = harness()
    expect(await h.run('stop', '100')).toBe(0)
    expect(await h.run('start', '150')).toBe(0)
    expect(await h.run('snapshot', '100', 'before-x')).toBe(0)
    expect(h.posts.map((p) => [p.op, p.vmid])).toEqual([
      ['stop', '100'],
      ['start', '150'],
      ['snapshot', '100'],
    ])
    expect(h.posts[2]?.args).toMatchObject({
      name: 'before-x',
      description: expect.stringMatching(/^Auto-snapshot /),
    })
    // 190 has no pool our side checks: the request is sent and Proxmox's refusal comes back.
    await expect(h.run('start', '190')).rejects.toThrow(/Permission check failed/)
    expect(h.posts.at(-1)).toMatchObject({ op: 'start', vmid: '190' })
    await expect(h.run('snapshot', '100', 'bad name')).rejects.toThrow(/Snapshot names/)
    await expect(h.run('status', '12')).rejects.toBeInstanceOf(Refusal)
    expect(await h.run('destroy', '100')).toBe(2)
  })

  it('declares lab use with the default reason when --reason is empty', () => {
    expect(labUse('150', ['--hours', '4.0', '--reason', ''])).toEqual({
      reason: 'aico vm start 150',
      hours: 4,
    })
    expect(labUse('150', ['--reason', 'browser tests', '--hours', '2'])).toEqual({
      reason: 'browser tests',
      hours: 2,
    })
  })

  it('sends the caller identity st sends: owner token first, else the agent token', () => {
    const home = mkdtempSync(join(tmpdir(), 'aico-id-'))
    try {
      expect(summitflowIdentity({}, home)).toEqual({})
      mkdirSync(join(home, '.config/agent-tokens'), { recursive: true })
      writeFileSync(join(home, '.config/agent-tokens/summitflow'), 'agent\n')
      expect(summitflowIdentity({}, home)).toEqual({ 'X-SummitFlow-Agent-Token': 'agent' })
      mkdirSync(join(home, '.config/credstore/summitflow'), { recursive: true })
      writeFileSync(join(home, '.config/credstore/summitflow/owner-token'), 'owner')
      expect(summitflowIdentity({}, home)).toEqual({ 'X-SummitFlow-Owner-Token': 'owner' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('names snapshots like st vm', () => {
    expect(snapshotName(new Date('2026-11-04T13:05:09Z'))).toBe('snap-20261104-130509')
  })
})
