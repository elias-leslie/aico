import { describe, expect, it } from 'vitest'
import {
  guestRows,
  labUse,
  listLines,
  type PveRequest,
  pveRequest,
  routeOp,
  snapshotName,
  vm,
} from './vm'

const guests = [
  {
    vmid: 100,
    name: 'browser',
    type: 'qemu',
    status: 'running',
    pool: 'lab',
    node: 'pve',
    maxmem: 8589934592,
    maxdisk: 107374182400,
  },
  {
    vmid: 150,
    name: 'hub',
    type: 'lxc',
    status: 'running',
    pool: 'ops',
    node: 'pve',
    maxmem: 1073741824,
    maxdisk: 1,
  },
]
function fixture() {
  const calls: unknown[][] = []
  const out: string[] = [],
    err: string[] = []
  const api: PveRequest = async (method, path, body) => {
    calls.push([method, path, body])
    if (path.includes('resources')) return guests
    if (path.includes('/tasks/')) return { status: 'stopped', exitstatus: 'OK' }
    if (path.endsWith('/status/current'))
      return { status: 'running', cpu: 0.123, mem: 2147483648, maxmem: 8589934592, uptime: 42 }
    return 'UPID:task'
  }
  return {
    calls,
    out,
    err,
    api,
    run: (...args: string[]) =>
      vm(
        args,
        routeOp({}, api),
        () => ({ code: 0, out: '', err: '' }),
        (s) => out.push(s),
        (s) => err.push(s),
      ),
  }
}
describe('direct scoped PVE operations', () => {
  it('lists the same guest rows without SF API', async () => {
    const h = fixture()
    expect(await h.run('list')).toBe(0)
    expect(h.out[2]).toContain('100')
    expect(h.calls).toEqual([['GET', '/cluster/resources?type=vm', undefined]])
    expect(guestRows(guests)[0].type).toBe('qemu')
    expect(listLines(guestRows(guests))).toHaveLength(4)
  })
  it('keeps the status line', async () => {
    const h = fixture()
    await h.run('status', '100')
    expect(h.out[0]).toBe('VM 100 (browser): running | CPU: 12% | RAM: 2048MB/8192MB | Uptime: 42s')
  })
  it.each([
    ['start', '100', '/qemu/100/status/start'],
    ['stop', '150', '/lxc/150/status/stop'],
    ['shutdown', '100', '/qemu/100/status/shutdown'],
    ['shutdown', '150', '/lxc/150/status/shutdown'],
    ['snapshot', '100', '/qemu/100/snapshot'],
  ])('routes %s to PVE and checks task completion', async (verb, id, path) => {
    const h = fixture()
    await h.run(verb, id, 'before-change')
    expect(h.calls.some((c) => String(c[1]).endsWith(path))).toBe(true)
    expect(h.calls.some((c) => String(c[1]).includes('/tasks/UPID%3Atask/status'))).toBe(true)
  })
  it('keeps PVE refusal authoritative and refuses invisible guests', async () => {
    const h = fixture()
    await expect(h.run('stop', '999')).rejects.toThrow('No visible')
    const api: PveRequest = async (method) => {
      if (method === 'GET') return guests
      throw new Error('Proxmox API refused the operation (HTTP 403)')
    }
    await expect(routeOp({}, api)('stop', '100')).rejects.toThrow('403')
  })
  it('reports a failed PVE task', async () => {
    const api: PveRequest = async (_method, path) =>
      path.includes('resources')
        ? guests
        : path.includes('/tasks/')
          ? { status: 'stopped', exitstatus: 'permission denied' }
          : 'UPID:task'
    await expect(routeOp({}, api)('start', '100')).rejects.toThrow('permission denied')
  })
  it('validates ids and snapshot names before writes', async () => {
    const h = fixture()
    await expect(h.run('stop', '100;true')).rejects.toThrow()
    await expect(h.run('snapshot', '100', 'current')).rejects.toThrow()
    expect(h.calls).toEqual([])
    expect(snapshotName(new Date('2026-11-05T03:00:00Z'))).toMatch(/^snap-/)
  })
})

it('preserves lab-use reason and hours defaults and explicit overrides', () => {
  expect(labUse('150', ['--hours', '4.0', '--reason', ''])).toEqual({
    reason: 'aico vm start 150',
    hours: 4,
  })
  expect(labUse('150', ['--reason', 'browser tests', '--hours', '2'])).toEqual({
    reason: 'browser tests',
    hours: 2,
  })
  expect(snapshotName(new Date('2026-11-04T13:05:09Z'))).toBe('snap-20261104-130509')
})
it('rejects too-small ids and unsupported verbs before any API write', async () => {
  const h = fixture()
  await expect(h.run('status', '12')).rejects.toThrow('from 100')
  expect(await h.run('destroy', '100')).toBe(2)
  expect(h.calls).toEqual([])
})
it('uses only the scoped login and pinned CA at the HTTPS boundary', async () => {
  const { EventEmitter } = await import('node:events')
  const sent: {
    url?: URL
    options?: import('node:https').RequestOptions
    payload?: unknown
    timeout?: number
  } = {}
  const requester = ((
    url: URL,
    options: import('node:https').RequestOptions,
    callback: (response: import('node:http').IncomingMessage) => void,
  ) => {
    sent.url = url
    sent.options = options
    const req = new EventEmitter() as import('node:http').ClientRequest
    req.setTimeout = ((time: number) => {
      sent.timeout = time
      return req
    }) as typeof req.setTimeout
    req.end = ((payload: unknown) => {
      sent.payload = payload
      queueMicrotask(() => {
        const response = new EventEmitter() as import('node:http').IncomingMessage
        response.statusCode = 200
        callback(response)
        response.emit('data', Buffer.from('{"data":[]}'))
        response.emit('end')
      })
      return req
    }) as typeof req.end
    return req
  }) as unknown as typeof import('node:https').request
  let fetched = 0
  const call = pveRequest(
    {},
    {
      credential: async () => {
        fetched++
        return { tokenId: 'fixture@pve!scoped', tokenSecret: 'fixture-private' }
      },
      ca: () => Buffer.from('fixture-ca'),
      request: requester,
    },
  )
  expect(await call('POST', '/nodes/node/qemu/100/status/start', { force: 0 })).toEqual([])
  expect(sent.url?.protocol).toBe('https:')
  expect(sent.url?.pathname).toBe('/api2/json/nodes/node/qemu/100/status/start')
  expect(sent.options?.ca).toEqual(Buffer.from('fixture-ca'))
  expect(sent.options?.headers).toMatchObject({
    Authorization: 'PVEAPIToken=fixture@pve!scoped=fixture-private',
  })
  expect(sent.options).not.toHaveProperty('rejectUnauthorized', false)
  expect(sent.timeout).toBeGreaterThan(0)
  expect(sent.payload).toBe('force=0')
  // Task polling reuses the operation's token instead of reading Logins on every request.
  await call('GET', '/nodes/node/tasks/UPID/status')
  await call('GET', '/nodes/node/tasks/UPID/status')
  expect(fetched).toBe(1)
})
it('keeps a deploy source root distinct from the installed runtime root', async () => {
  const { repoRoot } = await import('./main')
  expect(
    repoRoot({ AICO_DEPLOY_ROOT: '/source-checkout', AICO_REPO_ROOT: '/installed-release' }),
  ).toBe('/source-checkout')
})
