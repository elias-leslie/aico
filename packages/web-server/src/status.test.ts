import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type StatusRow, StatusStore } from '@aico/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Router } from './http'
import { createWebServer } from './server'
import { registerStatusRoutes, startSelfRows } from './status'
import { formatStatus, runStatusCli, type StatusCliIo, when } from './status-cli'
import type { TerminalHub } from './terminal'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const guard = {
  allowedHostnames: ['localhost', '127.0.0.1', 'aico.example.dev'],
  allowedOrigins: ['http://127.0.0.1:3002', 'https://aico.example.dev'],
}
const ROW: StatusRow = {
  id: 'here/backup',
  what: 'Backup',
  kind: 'backup',
  machine: 'here',
  state: 'ok',
  meaning: 'Copied.',
  next_run: '2026-11-03T11:00:00Z',
}
/** Without a machine row, a machine's rows show unknown. */
const MACHINE: StatusRow = {
  id: 'here/machine',
  what: 'here',
  kind: 'machine',
  machine: 'here',
  state: 'ok',
  meaning: 'Up.',
  next_run: '2026-11-03T13:00:00Z',
}

let server: Server
let status: StatusStore
let port: number

beforeEach(async () => {
  status = new StatusStore(':memory:', () => NOW)
  const router = new Router()
  registerStatusRoutes(router, status)
  server = createWebServer(guard, router, {} as TerminalHub)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  status.close()
})

/** A request with the headers of the caller's choosing (fetch will not set Host). */
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

describe('status routes', () => {
  it('takes a row from this machine and serves it late once its next run has passed', async () => {
    expect(await call('POST', '/api/status/rows', { body: [ROW, MACHINE] })).toEqual({
      status: 200,
      body: { written: 2 },
    })
    const { body } = await call('GET', '/api/status')
    expect(body.rollup).toMatchObject({ problems: 1, healthy: 1 })
    expect(body.rows[0]).toMatchObject({
      id: 'here/backup',
      state: 'ok',
      shown: 'late',
      shown_since: '2026-11-03T11:00:00.000Z',
      updated_at: '2026-11-03T12:00:00.000Z',
    })
  })

  it.each([
    ['the public host', { host: 'aico.example.dev' }],
    ['a proxied request', { 'x-forwarded-for': '203.0.113.9' }],
    ['a page in a browser', { origin: 'http://127.0.0.1:3002' }],
  ])('refuses writes from %s', async (_name, headers) => {
    const post = await call('POST', '/api/status/rows', { body: ROW, headers })
    expect(post.status).toBe(403)
    expect(post.body.detail).toMatch(/only by programs on this machine/)
    const remove = await call('DELETE', '/api/status/rows?id=here%2Fbackup', { headers })
    expect(remove.status).toBe(403)
    expect(status.rows()).toEqual([])
  })

  it('refuses a machine row without next_run, and shows rows of a machine without one unknown', async () => {
    const { next_run: _due, ...silent } = MACHINE
    const refused = await call('POST', '/api/status/rows', { body: silent })
    expect(refused).toEqual({ status: 422, body: { detail: expect.stringMatching(/^next_run: /) } })
    await call('POST', '/api/status/rows', { body: ROW })
    const { body } = await call('GET', '/api/status')
    expect(body.rows[0]).toMatchObject({ id: 'here/backup', shown: 'unknown', shown_since: null })
  })

  it('lets the public host read', async () => {
    status.upsert([ROW])
    const { status: code, body } = await call('GET', '/api/status', {
      headers: { host: 'aico.example.dev' },
    })
    expect(code).toBe(200)
    expect(body.rows).toHaveLength(1)
  })

  it('names the field a refused row got wrong, and writes none of a bad batch', async () => {
    const one = await call('POST', '/api/status/rows', { body: { ...ROW, state: 'late' } })
    expect(one.status).toBe(422)
    expect(one.body.detail).toMatch(/^state: /)
    const batch = await call('POST', '/api/status/rows', {
      body: [ROW, { ...ROW, id: 'here/x', kind: 'cron' }],
    })
    expect(batch.status).toBe(422)
    expect(batch.body.detail).toMatch(/^rows\[1\]\.kind: /)
    expect(status.rows()).toEqual([])
  })

  it('filters, sorts and refuses unknown filter values', async () => {
    await call('POST', '/api/status/rows', {
      body: [
        ROW,
        MACHINE,
        { ...ROW, id: 'here/web', what: 'Web', kind: 'service', next_run: undefined },
      ],
    })
    const late = await call('GET', '/api/status?state=late')
    expect(late.body.rows.map((row: { id: string }) => row.id)).toEqual(['here/backup'])
    const services = await call('GET', '/api/status?kind=service,job&q=WEB&sort=what')
    expect(services.body.rows.map((row: { id: string }) => row.id)).toEqual(['here/web'])
    expect((await call('GET', '/api/status?sort=size')).status).toBe(422)
    expect((await call('GET', '/api/status?state=late,broken')).body.detail).toMatch(/broken/)
  })

  it('removes a row by id', async () => {
    await call('POST', '/api/status/rows', { body: ROW })
    const first = await call('DELETE', '/api/status/rows?id=here%2Fbackup')
    expect(first.body).toEqual({ removed: true })
    expect((await call('DELETE', '/api/status/rows?id=here%2Fbackup')).body).toEqual({
      removed: false,
    })
  })
})

describe("aico-web's own rows", () => {
  it('reports the machine and the service each beat, and the service off when stopped', () => {
    const store = new StatusStore(':memory:', () => NOW)
    const rows = startSelfRows({
      status: store,
      hostName: 'here',
      address: '127.0.0.1:3002',
      heartbeatMs: 300_000,
      now: () => NOW,
    })
    expect(store.read().rows.map((row) => [row.id, row.kind, row.shown, row.next_run])).toEqual([
      ['here/aico-web', 'service', 'ok', '2026-11-03T12:10:00.000Z'],
      ['here/machine', 'machine', 'ok', '2026-11-03T12:10:00.000Z'],
    ])
    rows.stop('SIGTERM')
    const web = store.read({ kind: ['service'] }).rows[0]
    expect(web).toMatchObject({ state: 'off', meaning: 'Stopped (SIGTERM).' })
    expect(web?.next_run).toBeUndefined()
    store.close()
  })
})

describe('st status', () => {
  function io(
    answer: () => Promise<Response>,
  ): StatusCliIo & { text: string; errors: string; urls: string[] } {
    const result = {
      text: '',
      errors: '',
      urls: [] as string[],
      baseUrl: 'http://127.0.0.1:3002',
      now: () => NOW,
      out: (text: string) => {
        result.text += text
      },
      err: (text: string) => {
        result.errors += text
      },
      fetch: (async (url: string) => {
        result.urls.push(url)
        return answer()
      }) as typeof fetch,
    }
    return result
  }

  it('lists problems with what to do and folds healthy rows into a count', async () => {
    const store = new StatusStore(':memory:', () => NOW)
    store.upsert([
      ROW,
      MACHINE,
      { ...ROW, id: 'here/web', what: 'Web', kind: 'service', next_run: undefined },
      {
        ...ROW,
        id: 'here/export',
        what: 'Export',
        kind: 'job',
        state: 'failed',
        meaning: 'No login.',
        next_run: undefined,
        actions: [{ kind: 'run', ref: 'systemctl --user start x.service' }],
      },
    ])
    const view = store.read()
    const text = formatStatus(view, false, NOW)
    expect(text).toContain('2 problems, 2 healthy.')
    expect(text).toContain('Failed   Export (job, here)')
    expect(text).toContain('Run now: systemctl --user start x.service')
    expect(text).toContain(
      `Late     Backup (backup, here), late since ${when('2026-11-03T11:00:00Z', NOW)}`,
    )
    expect(text).toContain('2 healthy (2 ok) not listed; --all lists them.')
    expect(text).not.toContain('Web (service')
    expect(formatStatus(view, true, NOW)).toContain('OK       Web (service, here)')
    store.close()
  })

  it('says a machine with no machine row has not been heard from', () => {
    const store = new StatusStore(':memory:', () => NOW)
    store.upsert([{ ...ROW, machine: 'there', id: 'there/backup' }])
    expect(formatStatus(store.read(), false, NOW)).toContain(
      'Unknown  Backup (backup, there), no word from there\n',
    )
    store.close()
  })

  it('says when nothing needs the owner, and when there are no rows yet', () => {
    const empty = { generated_at: '', rows: [], rollup: { problems: 0, healthy: 0, counts: {} } }
    expect(formatStatus(empty as never, false, NOW)).toMatch(/^No status rows yet/)
    expect(formatStatus(empty as never, false, NOW, true)).toBe('No status rows match.\n')
  })

  it('passes filters to the API and says plainly when Aico is not answering', async () => {
    const answered = io(async () => Response.json({ generated_at: '', rows: [], rollup: {} }))
    expect(await runStatusCli(['--state', 'late,failed', '--machine', 'here'], answered)).toBe(0)
    expect(answered.urls).toEqual([
      'http://127.0.0.1:3002/api/status?state=late%2Cfailed&machine=here',
    ])
    const down = io(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await runStatusCli([], down)).toBe(69)
    expect(down.errors).toMatch(/^Aico isn't answering at http:\/\/127\.0\.0\.1:3002/)
    const refused = io(async () =>
      Response.json({ detail: 'sort must be one of x' }, { status: 422 }),
    )
    expect(await runStatusCli(['--sort', 'size'], refused)).toBe(2)
    expect(await runStatusCli(['--bogus'], refused)).toBe(2)
  })
})
