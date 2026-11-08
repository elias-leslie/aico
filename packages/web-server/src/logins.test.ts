import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextDbPath, openContext } from '@aico/context'
import { LoginStore, labIdentity, loginMachine } from '@aico/fleet/logins'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Router } from './http'
import { registerLoginRoutes } from './logins'

let home: string, server: Server, base: string
const probed: string[] = []
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'aico-logins-api-'))
  const router = new Router()
  probed.length = 0
  registerLoginRoutes(router, { HOME: home }, undefined, undefined, async (url) => {
    probed.push(url)
    return url.endsWith('/login/canvas')
      ? { finalUrl: url, password: true, suggestion: null, warning: '' }
      : {
          finalUrl: url,
          password: false,
          suggestion: 'https://canvas.example.test/login/canvas',
          warning: 'No password field.',
        }
  })
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
    { set: { username: 'fixture-updated', password: 'fixture-new-private-value' } },
    'PATCH',
  )
  expect(patched.status).toBe(200)
  const patchedText = await patched.text()
  // The username is shown on the page; the password never comes back.
  expect(patchedText).toContain('"username":"fixture-updated"')
  expect(patchedText).not.toContain('fixture-new-private-value')
  expect(
    (await post('/api/logins/assign', { session: 'hunt-one', targets: ['example-local'] })).status,
  ).toBe(200)
  const store = new LoginStore({ HOME: home })
  // An account stays closed to a hunter however it is assigned; the owner's mark opens it.
  const hunter = { session: 'hunt-one', role: 'hunting', machine: loginMachine() }
  expect(store.list(hunter)).toHaveLength(0)
  store.huntersOk(labIdentity('example-local', 'viewer').name, true, {
    owner: true,
    role: 'owner',
    machine: loginMachine(),
  })
  expect(store.list(hunter)).toHaveLength(1)
})
it('the page sets and clears hunters OK on an account login, logged; a client value is refused', async () => {
  const name = labIdentity('hunters-site', 'default').name
  await post('/api/logins/lab', {
    target: 'hunters-site',
    actor: 'default',
    kind: 'account',
    values: {
      username: 'fixture-user',
      password: 'fixture-password',
      login_url: 'https://hunters.example.test/login',
    },
  })
  const hunter = { session: 'hunt-mark', role: 'hunting', machine: loginMachine() }
  const store = new LoginStore({ HOME: home })
  store.assign('hunt-mark', ['hunters-site'], {
    owner: true,
    role: 'owner',
    machine: loginMachine(),
  })
  expect(store.list(hunter)).toHaveLength(0)
  expect((await post(`/api/logins/${name}/hunters-ok`, { on: 'yes' })).status).toBe(400)
  const on = await post(`/api/logins/${name}/hunters-ok`, { on: true })
  expect(on.status).toBe(200)
  const body = await on.text()
  expect(body).toContain('"huntersOk":true')
  expect(body).not.toContain('fixture-password')
  expect(store.list(hunter).map((e) => e.name)).toEqual([name])
  expect((await post(`/api/logins/${name}/hunters-ok`, { on: false })).status).toBe(200)
  expect(store.list(hunter)).toHaveLength(0)
  expect(
    store
      .audit({ owner: true, role: 'owner', machine: loginMachine() })
      .filter((e) => e.action === 'hunters OK')
      .map((e) => e.detail),
  ).toEqual(['on', 'off'])
})
it('lists the registered work roles for the access checklist, none when no data folder is given', async () => {
  expect(await (await fetch(`${base}/api/logins/roles`)).json()).toEqual({ roles: [] })
  const dir = mkdtempSync(join(tmpdir(), 'aico-logins-roles-'))
  const db = openContext(contextDbPath(dir))
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('launch', ?)").run(
    JSON.stringify({
      version: 5,
      about: '',
      usage_providers: [],
      work_roles: ['coordinator', 'review'],
    }),
  )
  db.close()
  const router = new Router()
  registerLoginRoutes(router, { HOME: home }, undefined, dir)
  const other = createServer((req, res) => {
    void router.handle(req, res, new URL(req.url || '/', 'http://localhost'))
  })
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
  const address = other.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  try {
    const answer = await fetch(`http://127.0.0.1:${address.port}/api/logins/roles`)
    expect(await answer.json()).toEqual({ roles: ['coordinator', 'review'] })
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
it('checks an account login page on save and lets the owner fix notes, page and site name', async () => {
  const saved = await post('/api/logins/lab', {
    target: 'canvas-pcsb',
    actor: 'default',
    kind: 'account',
    values: {
      username: 'me@example.test',
      password: 'fixture-private-value',
      login_url: 'https://canvas.example.test/',
    },
  })
  expect(await saved.json()).toMatchObject({
    probe: { password: false, suggestion: 'https://canvas.example.test/login/canvas' },
  })
  const edited = await post('/api/logins/canvas-pcsb/edit', {
    notes: 'School check',
    login_url: 'https://canvas.example.test/login/canvas',
  })
  const body = await edited.json()
  expect(body).toMatchObject({
    entry: {
      notes: 'School check',
      lab: { login_url: 'https://canvas.example.test/login/canvas' },
    },
    probe: { password: true },
  })
  expect(JSON.stringify(body)).not.toContain('fixture-private-value')
  expect(probed).toEqual([
    'https://canvas.example.test/',
    'https://canvas.example.test/login/canvas',
  ])
  expect((await post('/api/logins/canvas-pcsb/edit', { notes: 3 })).status).toBe(400)
  expect((await post('/api/logins/canvas-pcsb/edit', { kind: 3 })).status).toBe(400)
  const audit = (await (await fetch(`${base}/api/logins/audit`)).json()) as {
    events: Record<string, unknown>[]
  }
  expect(audit.events.at(-1)).toMatchObject({
    action: 'edit',
    actor: 'owner',
    detail:
      'notes, login page https://canvas.example.test/ to https://canvas.example.test/login/canvas',
  })
  expect(
    await (await post('/api/logins/probe', { url: 'https://canvas.example.test/' })).json(),
  ).toMatchObject({ probe: { suggestion: 'https://canvas.example.test/login/canvas' } })
  await post('/api/logins', { name: 'key', kind: 'password', value: 'fixture-private-value' })
  const kind = await post('/api/logins/key/edit', { kind: 'backup key' })
  expect(await kind.json()).toMatchObject({ entry: { name: 'key', kind: 'backup key' } })
})
