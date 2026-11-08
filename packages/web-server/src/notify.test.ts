import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_CHOICES } from '@aico/notify'
import { StatusStore } from '@aico/status'
import { TetherError } from '@aico/tether-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { privateListen } from './config'
import { Router } from './http'
import { changedAsk, hubKeyAccepted, hubSource, NotifyHub, tetherAsks } from './notify'
import { createWebServer } from './server'
import { registerStatusRoutes } from './status'
import type { TerminalHub } from './terminal'

const guard = {
  allowedHostnames: ['localhost', '127.0.0.1', 'aico.example.dev'],
  allowedOrigins: ['https://aico.example.dev'],
}
const KEY = 'test-hub-key'

let dir: string
let server: Server
let port: number
let hub: NotifyHub
let status: StatusStore
let tetherCalls: { method: string; path: string; body: unknown }[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aico-notify-'))
  const keysFile = join(dir, 'ominull-keys.json')
  writeFileSync(
    keysFile,
    JSON.stringify({
      keys: [{ name: 'hub', sha256: createHash('sha256').update(KEY).digest('hex') }],
    }),
  )
  tetherCalls = []
  status = new StatusStore(':memory:')
  hub = new NotifyHub({
    hostName: 'test-host',
    config: {
      fcmTokenFile: join(dir, 'no-token.json'),
      devicesFile: join(dir, 'no-devices.json'),
      passMs: 30_000,
      ominull: {
        keysFile,
        listen: null,
        siteFile: join(dir, 'site.json'),
        relayKeyFile: join(dir, 'relay.key'),
      },
    },
    dataDir: dir,
    publicHost: 'aico.example.dev',
    machine: 'here',
    choices: NO_CHOICES,
    status,
    tether: {
      request: (async (method: string, path: string, body?: unknown) => {
        tetherCalls.push({ method, path, body })
        return { status: 201, body: { id: `ask${tetherCalls.length}` } }
      }) as never,
    },
  })
  const router = new Router()
  registerStatusRoutes(router, status, { changed: hub })
  hub.register(router)
  server = createWebServer(guard, router, {} as TerminalHub)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  hub.stop()
  status.close()
})

function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
  // biome-ignore lint/suspicious/noExplicitAny: test JSON answers
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || 'null') }),
        )
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

const alert = {
  v: 1,
  source: 'ominull',
  severity: 'critical',
  title: 'TEST: new outbound connection',
  body: 'A test alert.',
  key: 'alerts:abc',
  actions: ['expected', 'not-expected'],
}

describe('POST /api/notices', () => {
  it('logs a notice from this machine and refuses one through the public host', async () => {
    const notice = { v: 1, source: 'aico', title: 'Hello', body: 'B' }
    const taken = await call('POST', '/api/notices', { body: notice })
    expect(taken.status).toBe(200)
    expect(taken.body).toMatchObject({ repeat: false })
    const proxied = await call('POST', '/api/notices', {
      body: notice,
      headers: { host: 'aico.example.dev', 'x-forwarded-for': '203.0.113.9' },
    })
    expect(proxied.status).toBe(403)
    const bad = await call('POST', '/api/notices', { body: { ...notice, colour: 'red' } })
    expect(bad).toMatchObject({ status: 422 })
    expect(bad.body.detail).toMatch(/^colour: /)
    const log = await call('GET', '/api/notices')
    expect(log.body.items.map((item: { id: string }) => item.id)).toEqual([taken.body.id])
  })
})

describe('POST /api/notices/resolve', () => {
  it("ends a loopback sender's notice by key and refuses the public host", async () => {
    const notice = {
      v: 1,
      source: 'tether',
      kind: 'todo',
      title: 'Claude Code waiting in S',
      body: 'Open it in Aico to answer.',
      key: 'aico-waiting:0123abcd',
    }
    expect((await call('POST', '/api/notices', { body: notice })).status).toBe(200)
    const body = { source: 'tether', key: 'aico-waiting:0123abcd', text: 'No longer waits.' }
    const proxied = await call('POST', '/api/notices/resolve', {
      body,
      headers: { host: 'aico.example.dev', 'x-forwarded-for': '203.0.113.9' },
    })
    expect(proxied.status).toBe(403)
    const resolved = await call('POST', '/api/notices/resolve', { body })
    expect(resolved.status).toBe(200)
    expect(resolved.body).toMatchObject({ resolved: 1 })
    expect(
      (await call('POST', '/api/notices/resolve', { body: { ...body, key: '' } })).status,
    ).toBe(422)
  })
})

describe('POST /api/ominull/push', () => {
  const row = {
    id: 'ominull/hub',
    what: 'OmniNull hub',
    kind: 'service',
    machine: 'labhub',
    state: 'ok',
    meaning: 'Up.',
  }

  it('tells the hub about the fleet in its reply, and a failed reading does not fail the push', async () => {
    const headers = { 'x-api-key': KEY }
    hub.hubFleet = () => [{ machine: 'here', intent: 'always', up: true, reports: true }]
    const told = await call('POST', '/api/ominull/push', { body: { rows: [row] }, headers })
    expect(told.body).toMatchObject({ machines: [{ machine: 'here', up: true }] })
    hub.hubFleet = () => {
      throw new Error('no reading')
    }
    const failed = await call('POST', '/api/ominull/push', { body: { rows: [row] }, headers })
    expect(failed.status).toBe(200)
    expect(failed.body).not.toHaveProperty('machines')
  })

  it('takes notices and rows with a listed key, and files the "That was me" ask', async () => {
    const answer = await call('POST', '/api/ominull/push', {
      body: { notices: [alert], rows: [row] },
      headers: { 'x-api-key': KEY },
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ notices: [{ repeat: false }], rows: 1 })
    expect(status.rows().map(({ row: r }) => r.id)).toEqual(['ominull/hub'])
    await settle()
    expect(tetherCalls).toEqual([
      {
        method: 'POST',
        path: '/v1/asks',
        body: expect.objectContaining({
          requester: 'ominull',
          question: expect.stringMatching(
            /^Was this you\? TEST: new outbound connection \(#[0-9a-f]{6}\)$/,
          ),
          options: ['That was me', 'Not me'],
          blocking: false,
        }),
      },
    ])
    const stored = hub.store.get(answer.body.notices[0].id)
    expect(stored).toMatchObject({ via: 'ominull', askId: 'ask1' })
  })

  it('refuses a missing or unknown key, a proxied caller, and anything not the hub’s', async () => {
    const push = (body: unknown, headers: Record<string, string> = { 'x-api-key': KEY }) =>
      call('POST', '/api/ominull/push', { body, headers })
    expect((await push({ notices: [alert] }, {})).status).toBe(401)
    expect((await push({ notices: [alert] }, { 'x-api-key': 'nope' })).status).toBe(401)
    expect(
      (await push({ notices: [alert] }, { 'x-api-key': KEY, 'cf-connecting-ip': '203.0.113.9' }))
        .status,
    ).toBe(403)
    const local = await push({ notices: [{ ...alert, source: 'aico' }] })
    expect(local).toMatchObject({ status: 422, body: { detail: 'notices[0].source: ominull' } })
    const foreignRow = await push({ rows: [{ ...row, id: 'here/backup' }] })
    expect(foreignRow).toMatchObject({
      status: 422,
      body: { detail: 'rows[0].id: starts with ominull' },
    })
    // Nothing of a refused push was taken.
    expect(hub.store.list()).toEqual([])
    expect(status.rows()).toEqual([])
  })
})

describe('the one list', () => {
  it('a recovery synced from another Aico closes the ask here', async () => {
    const answer = await call('POST', '/api/ominull/push', {
      body: { notices: [alert] },
      headers: { 'x-api-key': KEY },
    })
    await settle()
    expect(hub.store.get(answer.body.notices[0].id)?.askId).toBe('ask1')
    tetherCalls.length = 0
    const { afterApply } = hub.syncHandle()
    const ok = { ...alert, severity: 'ok' }
    const row = { id: 'gem-ok', source: 'ominull', key: alert.key, doc: JSON.stringify(ok) }
    afterApply?.([{ table: 'notices', row }])
    await settle()
    expect(tetherCalls.map((c) => c.path)).toEqual([expect.stringContaining('/v1/asks/ask1')])
  })
})

describe('Needs you through Status rows', () => {
  it('withdraws previously raised ordinary failed-row asks when the hub starts', async () => {
    const old = {
      id: 'jobs/old-agent-problem',
      what: 'Old agent problem',
      kind: 'job' as const,
      machine: 'here',
      state: 'failed' as const,
      meaning: 'The agent can investigate.',
    }
    status.upsert([old])
    hub.store.setRowAsk(old.id, 'old-row-ask', 0)
    hub.start()
    await settle()
    expect(tetherCalls.map((call) => [call.method, call.path])).toEqual([
      ['POST', '/v1/asks/old-row-ask/withdraw'],
    ])
    expect(hub.store.rowAsk(old.id)).toBeNull()
  })

  it('a failing owner-only action posted on loopback raises one ask; recovering withdraws it', async () => {
    const failing = {
      id: 'jobs/notes-export',
      what: 'Notes export to Drive',
      kind: 'job',
      machine: 'here',
      state: 'failed',
      meaning: 'No Drive login.',
      actions: [{ kind: 'run', ref: 'aico jobs run notes-export', owner_only: true }],
    }
    await call('POST', '/api/status/rows', { body: failing })
    await settle()
    await call('POST', '/api/status/rows', {
      body: { ...failing, state: 'ok', meaning: 'Copied.' },
    })
    await settle()
    expect(tetherCalls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/v1/asks'],
      ['POST', '/v1/asks/ask1/withdraw'],
    ])
    expect(tetherCalls[0]?.body).toMatchObject({
      requester: 'Aico Status',
      question: 'Notes export to Drive failed on here',
      command: 'aico jobs run notes-export',
    })
  })
})

describe('the pieces', () => {
  it('checks keys by their sha256 and reads the hub from the site file', () => {
    const keys = join(dir, 'ominull-keys.json')
    expect(hubKeyAccepted(KEY, keys)).toBe(true)
    expect(hubKeyAccepted('other', keys)).toBe(false)
    expect(hubKeyAccepted(KEY, join(dir, 'missing.json'))).toBe(false)
    const site = join(dir, 'site.json')
    writeFileSync(
      site,
      JSON.stringify({
        config: {
          ingest: {
            sources: [
              { name: 'ominull', url: 'https://10.0.0.5:9443/api/v1/x', ca_file: '/etc/ca.crt' },
            ],
          },
        },
      }),
    )
    expect(hubSource(site)).toEqual({ base: 'https://10.0.0.5:9443', ca: '/etc/ca.crt' })
  })

  it('logs a LAN door that cannot open and keeps going', async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)))
    const door = new NotifyHub({
      hostName: 'test-host',
      config: {
        fcmTokenFile: join(dir, 'no-token.json'),
        devicesFile: join(dir, 'no-devices.json'),
        passMs: 30_000,
        ominull: {
          keysFile: join(dir, 'ominull-keys.json'),
          // A private address this machine doesn't have: EADDRNOTAVAIL.
          listen: { host: '10.255.255.254', port: 3012 },
          siteFile: join(dir, 'site.json'),
          relayKeyFile: join(dir, 'relay.key'),
        },
      },
      dataDir: mkdtempSync(join(tmpdir(), 'aico-notify-door-')),
      publicHost: null,
      machine: 'here',
      choices: NO_CHOICES,
      status,
      tether: { request: (async () => ({ status: 201, body: { id: 'x' } })) as never },
    })
    try {
      door.start()
      await vi.waitFor(() =>
        expect(errors).toContain(
          '[notify] OmniNull door on 10.255.255.254:3012 is closed: listen EADDRNOTAVAIL: address not available 10.255.255.254:3012',
        ),
      )
      expect((await call('GET', '/api/notices')).status).toBe(200)
    } finally {
      door.stop()
      spy.mockRestore()
    }
  })

  it('takes the LAN door only on a private address', () => {
    expect(privateListen('192.168.86.10:3012')).toEqual({ host: '192.168.86.10', port: 3012 })
    expect(privateListen('0.0.0.0:3012')).toBeNull()
    expect(privateListen('8.8.8.8:3012')).toBeNull()
    expect(privateListen(undefined)).toBeNull()
  })

  it('reads an asks.changed event and treats a closed ask as closed', async () => {
    expect(changedAsk({ ask: { id: 'a', state: 'answered', answer: 'That was me' } })).toEqual({
      id: 'a',
      state: 'answered',
      answer: 'That was me',
    })
    expect(changedAsk({})).toBeNull()
    const closed = tetherAsks({
      request: (async () => {
        throw new TetherError(409, 'ask_closed', {})
      }) as never,
    })
    await expect(closed.close('a', 'done')).resolves.toBeUndefined()
  })
})
