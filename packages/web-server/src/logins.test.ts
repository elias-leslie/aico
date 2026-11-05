import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoginStore, loginMachine } from '@aico/fleet/logins'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Router } from './http'
import { registerLoginRoutes } from './logins'

let home: string, server: Server, base: string
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'aico-logins-api-'))
  const router = new Router()
  registerLoginRoutes(router, { HOME: home })
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
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const post = (path: string, body: unknown, method = 'POST') =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
it('lists no values, records each reveal and refuses malformed writes without logging input', async () => {
  const logger = vi.spyOn(console, 'error')
  const saved = await post('/api/logins', {
    name: 'scratch',
    kind: 'password',
    value: 'fixture-private-value',
  })
  expect(saved.status).toBe(200)
  expect(await saved.text()).not.toContain('fixture-private-value')
  const listed = await fetch(`${base}/api/logins`)
  expect(await listed.text()).not.toContain('fixture-private-value')
  const revealed = await post('/api/logins/scratch/reveal', {})
  expect(revealed.headers.get('cache-control')).toBe('no-store')
  expect(await revealed.json()).toMatchObject({ value: 'fixture-private-value', hideAfter: 30 })
  const audit = await (await fetch(`${base}/api/logins/audit`)).text()
  expect(audit).toContain('reveal')
  expect(audit).not.toContain('fixture-private-value')
  const bad = await post('/api/logins', { name: 'index.json', value: 'fixture-private-value' })
  expect(bad.status).toBe(400)
  expect(await bad.text()).not.toContain('fixture-private-value')
  expect(logger).not.toHaveBeenCalled()
  expect((await post('/api/logins/scratch/remove', { confirm: 'wrong' })).status).toBe(400)
  expect((await post('/api/logins/scratch/remove', { confirm: 'scratch' })).status).toBe(200)
})
it('supports lab partial edits and assignments without returning field values', async () => {
  expect(
    (
      await post('/api/logins/lab', {
        target: 'example-local',
        actor: 'viewer',
        kind: 'account',
        values: { username: 'fixture-user', password: 'fixture-private-value' },
      })
    ).status,
  ).toBe(200)
  const patched = await post(
    '/api/logins/lab/example-local/viewer',
    { set: { username: 'fixture-updated' } },
    'PATCH',
  )
  expect(patched.status).toBe(200)
  expect(await patched.text()).not.toContain('fixture-updated')
  expect(
    (await post('/api/logins/assign', { session: 'hunt-one', targets: ['example-local'] })).status,
  ).toBe(200)
  const store = new LoginStore({ HOME: home })
  expect(
    store.list({ session: 'hunt-one', role: 'hunting', machine: loginMachine() }),
  ).toHaveLength(1)
})
