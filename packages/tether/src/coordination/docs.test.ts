import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpError, Router } from '../http'
import { Store } from '../store'
import { CoordinationDocs, registerCoordinationRoutes } from './docs'

describe('CoordinationDocs', () => {
  it('reads an unwritten document as empty at version 0, then versions each write', () => {
    const docs = new CoordinationDocs(new Store(':memory:').db)
    expect(docs.get('aico')).toMatchObject({ version: 0, doc: {} })
    expect(docs.put('aico', { leases: [] }, null)).toBe(1)
    expect(docs.put('aico', { leases: [1] }, null)).toBe(2)
    expect(docs.get('aico')).toMatchObject({ version: 2, doc: { leases: [1] } })
    expect(docs.names().map((n) => n.name)).toEqual(['aico'])
  })

  it('refuses a write without the holder token while the document is locked', async () => {
    const docs = new CoordinationDocs(new Store(':memory:').db)
    const token = await docs.lock('aico', 0, 5000)
    expect(token).toBeTruthy()
    expect(() => docs.put('aico', {}, null)).toThrow(HttpError)
    expect(docs.put('aico', { a: 1 }, token)).toBe(1)
    expect(await docs.lock('aico', 0, 5000)).toBeNull()
    expect(docs.unlock('aico', 'wrong')).toBe(false)
    expect(docs.unlock('aico', token as string)).toBe(true)
    expect(await docs.lock('aico', 0, 5000)).toBeTruthy()
  })

  it('hands the lock to a waiter on release, and frees one whose holder never came back', async () => {
    let t = 1000
    const docs = new CoordinationDocs(new Store(':memory:').db, () => t)
    const first = (await docs.lock('p', 0, 5000)) as string
    const waiter = docs.lock('p', 3000, 5000)
    docs.unlock('p', first)
    expect(await waiter).toBeTruthy()
    t += 6000 // the holder crashed: its ttl ran out
    expect(await docs.lock('p', 0, 5000)).toBeTruthy()
  })
})

describe('coordination routes', () => {
  const servers: Array<ReturnType<typeof createServer>> = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.close()
  })
  async function start() {
    const router = new Router()
    registerCoordinationRoutes(router, new CoordinationDocs(new Store(':memory:').db))
    const server = createServer((req, res) => {
      router.dispatch(req, res).catch((e: unknown) => {
        const err = e instanceof HttpError ? e : new HttpError(500, 'internal')
        res.writeHead(err.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: err.code }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/coordination`
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json()) as Record<string, unknown> }
    }
    return call
  }

  it('locks, writes with the token, reads back and releases', async () => {
    const call = await start()
    const lock = (await call('POST', '/docs/_coord/lock', { waitMs: 0 })).body.lock as string
    expect(lock).toMatch(/^[0-9a-f]{16}$/)
    expect((await call('POST', '/docs/_coord/lock', { waitMs: 0 })).status).toBe(423)
    expect((await call('PUT', '/docs/_coord', { doc: { messages: [] } })).status).toBe(409)
    expect((await call('PUT', '/docs/_coord', { doc: { messages: [] }, lock })).body.version).toBe(
      1,
    )
    expect((await call('GET', '/docs/_coord')).body).toMatchObject({
      version: 1,
      doc: { messages: [] },
    })
    expect((await call('DELETE', `/docs/_coord/lock?lock=${lock}`)).body.released).toBe(true)
    expect((await call('GET', '/docs')).body.items).toHaveLength(1)
  })

  it('rejects a bad name and a body that is not a document', async () => {
    const call = await start()
    expect((await call('GET', '/docs/.hidden')).status).toBe(400)
    expect((await call('PUT', '/docs/aico', { doc: [] })).status).toBe(400)
  })
})
