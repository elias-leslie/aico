import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMemory, contextDbPath, openContext } from '@aico/context'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Router } from './http'
import { registerMemoryRoutes } from './memory-routes'

interface Page {
  memories: { id: string; tier: string }[]
  next: number | null
}
const list = async (query: string) =>
  (await (await fetch(`${base}/api/memories${query}`)).json()) as Page
let dir: string, server: Server, base: string, ids: string[]
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aico-memory-api-'))
  mkdirSync(dir, { recursive: true })
  const db = openContext(contextDbPath(dir))
  const now = '2026-11-06T12:00:00.000Z'
  ids = [
    addMemory(db, { content: 'Always run the checks.', summary: 'Checks', tier: 'mandate' }, now),
    addMemory(
      db,
      { content: 'Deploy with the managed rebuild.', scope: 'project', scopeId: 'aico' },
      now,
    ),
    addMemory(db, { content: 'Old zebra note.', tier: 'archive' }, now),
  ].map((m) => m.id)
  db.close()
  const router = new Router()
  registerMemoryRoutes(router, { dataDir: dir })
  server = createServer((req, res) => {
    void router.handle(req, res, new URL(req.url || '/', 'http://localhost'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  base = `http://127.0.0.1:${address.port}`
})
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})
it('lists every scope, filters by tier and pages', async () => {
  const all = await list('')
  expect(all.memories).toHaveLength(3)
  expect(all.memories[0].tier).toBe('mandate')
  const tier = await list('?tier=archive')
  expect(tier.memories).toHaveLength(1)
  const page = await list('?limit=2')
  expect(page.memories).toHaveLength(2)
  expect(page.next).toBe(2)
  expect((await fetch(`${base}/api/memories?tier=nope`)).status).toBe(400)
})
it('searches by words and pages the matches', async () => {
  const found = await list('?q=zebra')
  expect(found.memories.map((m: { id: string }) => m.id)).toEqual([ids[2]])
  const none = await list('?q=nothingmatches')
  expect(none.memories).toEqual([])
})
it('deletes one memory by its full id and says so when it is already gone', async () => {
  const res = await fetch(`${base}/api/memories/${ids[2]}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect((await list('')).memories).toHaveLength(2)
  expect((await fetch(`${base}/api/memories/${ids[2]}`, { method: 'DELETE' })).status).toBe(404)
  expect(
    (await fetch(`${base}/api/memories/${ids[0]?.slice(0, 8)}`, { method: 'DELETE' })).status,
  ).toBe(404)
  expect((await list('')).memories).toHaveLength(2)
})
