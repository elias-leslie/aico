import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { request as httpsRequest } from 'node:https'
import { describe, expect, it } from 'vitest'
import {
  guestConfig,
  nodeStatus,
  PveError,
  pveLoginName,
  pveRequest,
  setOnboot,
  storageStatus,
  vmStatus,
  waitTask,
} from './proxmox'

interface Sent {
  url: URL
  options: Record<string, unknown>
  payload: string
}

/** A fake PVE over the https seam: answers come from `answer(sent)`. */
function fakeHttps(answer: (sent: Sent) => { status: number; body?: unknown }) {
  const sent: Sent[] = []
  const request = ((
    url: URL,
    options: Record<string, unknown>,
    callback: (r: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as ClientRequest
    ;(req as unknown as { setTimeout: unknown }).setTimeout = () => req
    ;(req as unknown as { end: unknown }).end = (payload?: string) => {
      const record = { url, options, payload: payload ?? '' }
      sent.push(record)
      const result = answer(record)
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage
        res.statusCode = result.status
        callback(res)
        res.emit('data', Buffer.from(JSON.stringify({ data: result.body ?? null })))
        res.emit('end')
      })
    }
    return req
  }) as unknown as typeof httpsRequest
  return { sent, request }
}

const token = { tokenId: 'aico@pve!ct190', tokenSecret: 'fixture-private' }

describe('Proxmox client', () => {
  it('signs with the PVEAPIToken and the pinned CA, and reads Logins once', async () => {
    const { sent, request } = fakeHttps(() => ({ status: 200, body: [1] }))
    let fetched = 0
    const call = pveRequest(
      {},
      {
        credential: async () => {
          fetched++
          return token
        },
        ca: () => Buffer.from('fixture-ca'),
        request,
      },
    )
    expect(await call('GET', '/cluster/resources?type=vm')).toEqual([1])
    await call('PUT', '/nodes/gem/lxc/150/config', { onboot: 1 })
    expect(sent[0].url.pathname + sent[0].url.search).toBe('/api2/json/cluster/resources?type=vm')
    expect(sent[0].options.ca).toEqual(Buffer.from('fixture-ca'))
    expect(sent[0].options.headers).toMatchObject({
      Authorization: 'PVEAPIToken=aico@pve!ct190=fixture-private',
    })
    expect(sent[0].options).not.toHaveProperty('rejectUnauthorized')
    expect(sent[1].payload).toBe('onboot=1')
    expect(fetched).toBe(1)
  })
  it('refetches the token once on a 401 (rotated) and retries', async () => {
    let answers = 0
    const { request } = fakeHttps(() =>
      answers++ === 0 ? { status: 401 } : { status: 200, body: 'ok' },
    )
    let fetched = 0
    const call = pveRequest(
      {},
      {
        credential: async () => {
          fetched++
          return token
        },
        ca: () => Buffer.from('ca'),
        request,
      },
    )
    expect(await call('GET', '/version')).toBe('ok')
    expect(fetched).toBe(2)
  })
  it('does not retry a 403 and names the status without the token', async () => {
    const { sent, request } = fakeHttps(() => ({ status: 403 }))
    const call = pveRequest(
      {},
      { credential: async () => token, ca: () => Buffer.from('ca'), request },
    )
    const error = (await call('POST', '/nodes/gem/qemu/200/status/start').catch(
      (e) => e,
    )) as PveError
    expect(error).toBeInstanceOf(PveError)
    expect(error.status).toBe(403)
    expect(error.message).toContain('HTTP 403')
    expect(error.message).not.toContain('fixture-private')
    expect(sent).toHaveLength(1)
  })
  it('refuses when the login is missing or incomplete', async () => {
    const missing = pveRequest(
      {},
      {
        credential: async () => {
          throw new Error('Login unavailable')
        },
      },
    )
    await expect(missing('GET', '/version')).rejects.toThrow('unavailable in Aico Logins')
    const partial = pveRequest({}, { credential: async () => ({ tokenId: 'a', tokenSecret: '' }) })
    await expect(partial('GET', '/version')).rejects.toThrow('incomplete')
  })
  it('chooses a machine’s own login, else the shared one', () => {
    expect(pveLoginName('aico')).toBe('proxmox-ct190')
    expect(pveLoginName('davion-sidarli')).toBe('proxmox-vm')
  })
  it('reads node, storage, VM and config; writes onboot', async () => {
    const calls: string[] = []
    const call = async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      return method === 'GET' && path.endsWith('/config') ? { onboot: 1 } : {}
    }
    await nodeStatus(call, 'gem')
    await storageStatus(call, 'gem', 'local-lvm')
    await vmStatus(call, 'gem', 200)
    expect(await guestConfig(call, { vmid: 150, type: 'lxc', node: 'gem' })).toEqual({ onboot: 1 })
    await setOnboot(call, { vmid: 150, type: 'lxc', node: 'gem' }, true)
    expect(calls).toEqual([
      'GET /nodes/gem/status',
      'GET /nodes/gem/storage/local-lvm/status',
      'GET /nodes/gem/qemu/200/status/current',
      'GET /nodes/gem/lxc/150/config',
      'PUT /nodes/gem/lxc/150/config',
    ])
    await expect(nodeStatus(call, '../x')).rejects.toThrow('node')
    await expect(storageStatus(call, 'gem', 'a b')).rejects.toThrow('storage')
    await expect(
      guestConfig(async () => null, { vmid: 1, type: 'lxc', node: 'gem' }),
    ).rejects.toThrow('not an object')
  })
  it('waits for a task and fails on a bad exit status', async () => {
    await waitTask(async () => ({ status: 'stopped', exitstatus: 'OK' }), 'gem', 'UPID:x')
    await expect(
      waitTask(async () => ({ status: 'stopped', exitstatus: 'command failed' }), 'gem', 'UPID:x'),
    ).rejects.toThrow('command failed')
    await expect(
      waitTask(async () => ({ status: 'running' }), 'gem', 'UPID:x', -1),
    ).rejects.toThrow('did not finish')
  })
})
