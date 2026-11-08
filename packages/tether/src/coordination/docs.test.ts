import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '@aico/session-engine/store'
import { HttpError, Router } from '@aico/shared/http'
import { afterEach, describe, expect, it } from 'vitest'
import { CoordinationDocs, registerCoordinationRoutes } from './docs'

describe('CoordinationDocs', () => {
  it('reads an unwritten document as empty at version 0, then versions each write', () => {
    const docs = new CoordinationDocs(new Store(':memory:').db)
    expect(docs.get('aico')).toMatchObject({ version: 0, doc: {} })
    expect(docs.put('aico', { leases: [] }, 0)).toBe(1)
    expect(docs.put('aico', { leases: [1] }, 1)).toBe(2)
    expect(docs.get('aico')).toMatchObject({ version: 2, doc: { leases: [1] } })
    expect(docs.names().map((n) => n.name)).toEqual(['aico'])
  })

  it('refuses a write over a version someone else saved since, so no update is lost', () => {
    const docs = new CoordinationDocs(new Store(':memory:').db)
    docs.put('aico', { leases: ['a'] }, 0)
    // Two writers read version 1; the first write wins, the second is refused with the current version.
    expect(docs.put('aico', { leases: ['a', 'b'] }, 1)).toBe(2)
    let refused: unknown
    try {
      docs.put('aico', { leases: ['a', 'c'] }, 1)
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(HttpError)
    expect(refused).toMatchObject({ status: 409, code: 'version_conflict', extra: { version: 2 } })
    expect(docs.get('aico').doc).toEqual({ leases: ['a', 'b'] })
    // The loser re-reads and redoes its change on top.
    expect(docs.put('aico', { leases: ['a', 'b', 'c'] }, 2)).toBe(3)
    // A writer that thinks the document is new cannot replace one that exists.
    expect(() => docs.put('aico', {}, 0)).toThrow(HttpError)
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
        res.end(JSON.stringify({ error: err.code, ...err.extra }))
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

  it('writes with the version read, refuses a stale version, and reads back', async () => {
    const call = await start()
    expect((await call('GET', '/docs/_coord')).body).toMatchObject({ version: 0, doc: {} })
    expect((await call('PUT', '/docs/_coord', { doc: { messages: [] } })).status).toBe(400)
    expect(
      (await call('PUT', '/docs/_coord', { doc: { messages: [] }, version: 0 })).body.version,
    ).toBe(1)
    const stale = await call('PUT', '/docs/_coord', { doc: {}, version: 0 })
    expect(stale).toMatchObject({ status: 409, body: { error: 'version_conflict', version: 1 } })
    expect((await call('GET', '/docs/_coord')).body).toMatchObject({
      version: 1,
      doc: { messages: [] },
    })
    expect((await call('POST', '/docs/_coord/lock', { waitMs: 0 })).status).toBe(404)
    expect((await call('GET', '/docs')).body.items).toHaveLength(1)
  })

  it('rejects a bad name and a body that is not a document', async () => {
    const call = await start()
    expect((await call('GET', '/docs/.hidden')).status).toBe(400)
    expect((await call('PUT', '/docs/aico', { doc: [] })).status).toBe(400)
  })
})
