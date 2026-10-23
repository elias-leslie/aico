import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindError,
  createSelectionListener,
  DEFAULT_EXTENSION_ID,
  type Delivery,
  isJsonContentType,
  MAX_BODY_BYTES,
  trustedExtensionIds,
} from './selection-listener'

// The trust-boundary cases the Python sidecar's test_security.py pinned, with
// the same status codes: the listener is unauthenticated, so these guards are
// what stop a visited website from typing into the active terminal.

const EXT = `chrome-extension://${DEFAULT_EXTENSION_ID}`
const DOM = { kind: 'dom', snippet: 'x' }

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  json(): unknown
}

type Listener = ReturnType<typeof createSelectionListener>
const running: Listener[] = []

afterEach(() => {
  for (const listener of running.splice(0)) listener.stop()
})

async function start(
  extensionIds?: string,
  delivery: Delivery = { delivered: true, reason: null },
) {
  const deliver = vi.fn(async () => delivery)
  const log = vi.fn()
  const listener = createSelectionListener({
    host: '127.0.0.1',
    port: 0,
    extensionIds,
    version: '9.9.9',
    deliver,
    log,
  })
  running.push(listener)
  const port = await listener.start()
  if (port === null) throw new Error('listener did not start')
  const send = (
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: string | Buffer | Buffer[] } = {},
  ): Promise<Reply> =>
    new Promise((done, fail) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: { host: `127.0.0.1:${port}`, ...opts.headers },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
              json: () => JSON.parse(body),
            })
          })
        },
      )
      // An over-cap upload is cut off once answered; the reply still arrives.
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') fail(error)
      })
      const { body } = opts
      if (Array.isArray(body)) {
        const write = (i: number): void => {
          if (i >= body.length) {
            req.end()
            return
          }
          if (req.destroyed) return
          req.write(body[i], () => write(i + 1))
        }
        write(0)
      } else req.end(body)
    })
  const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
    send('POST', path, {
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })
  return { port, deliver, log, send, post, listener }
}

describe('health', () => {
  it('answers the sidecar identity SummitFlow checks, for localhost and 127.0.0.1', async () => {
    const { send, port } = await start()
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const r = await send('GET', '/health', { headers: { host } })
      expect(r.status).toBe(200)
      expect(r.json()).toEqual({ status: 'ok', service: 'aico-sidecar', version: '9.9.9' })
    }
  })
})

describe('bind guard', () => {
  it('allows loopback hosts and refuses any other bind', () => {
    expect(bindError('127.0.0.1', 8005)).toBeNull()
    expect(bindError('localhost', 8005)).toBeNull()
    expect(bindError('0.0.0.0', 8005)).toMatch(/non-loopback/)
    expect(bindError('192.168.1.5', 8005)).toMatch(/non-loopback/)
  })

  it('refuses a port that is not a TCP port', () => {
    expect(bindError('127.0.0.1', 9001)).toBeNull()
    expect(bindError('127.0.0.1', Number.NaN)).toMatch(/invalid AICO_SIDECAR_PORT/)
    expect(bindError('127.0.0.1', Number('notaport'))).toMatch(/invalid AICO_SIDECAR_PORT/)
    expect(bindError('127.0.0.1', 70000)).toMatch(/invalid AICO_SIDECAR_PORT/)
  })

  it('does not start on a refused bind or a taken port, and says why', async () => {
    const log = vi.fn()
    const deliver = vi.fn()
    const remote = createSelectionListener({
      host: '0.0.0.0',
      port: 0,
      extensionIds: undefined,
      version: '1',
      deliver,
      log,
    })
    await expect(remote.start()).resolves.toBeNull()
    expect(log).toHaveBeenLastCalledWith(
      expect.stringMatching(/not started: refusing non-loopback/),
    )

    const holder = createServer()
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r))
    const taken = (holder.address() as { port: number }).port
    const clash = createSelectionListener({
      host: '127.0.0.1',
      port: taken,
      extensionIds: undefined,
      version: '1',
      deliver,
      log,
    })
    await expect(clash.start()).resolves.toBeNull()
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/not started: .*EADDRINUSE/))
    holder.close()
    remote.stop()
    clash.stop()
  })
})

describe('origin guard', () => {
  it('accepts native clients, which send no Origin', async () => {
    const { post } = await start()
    expect((await post('/selection/send', { items: [DOM] })).status).toBe(200)
  })

  it.each(['http://localhost:3005', 'http://127.0.0.1:3003', 'http://[::1]:8080', 'null'])(
    'refuses a local page (%s)',
    async (origin) => {
      const { post, deliver } = await start()
      expect((await post('/selection/send', { items: [DOM] }, { origin })).status).toBe(403)
      expect(deliver).not.toHaveBeenCalled()
    },
  )

  it('never lets a local page read a reply over CORS', async () => {
    const { send } = await start()
    const r = await send('GET', '/health', { headers: { origin: 'http://localhost:3005' } })
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('accepts the pinned extension', async () => {
    const { post } = await start()
    expect((await post('/selection/send', { items: [DOM] }, { origin: EXT })).status).toBe(200)
  })

  it('refuses any other installed extension', async () => {
    const { post } = await start()
    const origin = `chrome-extension://${'a'.repeat(32)}`
    expect((await post('/selection/send', { items: [DOM] }, { origin })).status).toBe(403)
  })

  it('echoes CORS only to the pinned extension', async () => {
    const { send } = await start()
    const ok = await send('GET', '/health', { headers: { origin: EXT } })
    expect(ok.headers['access-control-allow-origin']).toBe(EXT)
    const other = await send('GET', '/health', {
      headers: { origin: `chrome-extension://${'b'.repeat(32)}` },
    })
    expect(other.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers a preflight only for the pinned extension', async () => {
    const { send } = await start()
    const preflight = (origin: string) =>
      send('OPTIONS', '/selection/send', {
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      })
    const ok = await preflight(EXT)
    expect(ok.status).toBe(200)
    expect(ok.headers['access-control-allow-origin']).toBe(EXT)
    expect(ok.headers['access-control-allow-methods']).toBe('GET, POST')
    expect((await preflight('https://evil.com')).status).toBe(400)
  })

  it('replaces the default with configured extension IDs', async () => {
    const custom = 'c'.repeat(32)
    const { post } = await start(custom)
    const send = (origin: string) => post('/selection/send', { items: [DOM] }, { origin })
    expect((await send(`chrome-extension://${custom}`)).status).toBe(200)
    expect((await send(EXT)).status).toBe(403)
  })

  it('refuses a public site', async () => {
    const { post } = await start()
    const r = await post('/selection/send', { items: [DOM] }, { origin: 'https://evil.com' })
    expect(r.status).toBe(403)
    expect(r.json()).toEqual({ detail: 'origin not allowed' })
  })

  it('does not block reads by Origin; CORS keeps them private', async () => {
    const { send } = await start()
    const r = await send('GET', '/health', { headers: { origin: 'https://evil.com' } })
    expect(r.status).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('extension ID config', () => {
  it('trusts the bundled extension by default', () => {
    expect(trustedExtensionIds(undefined)).toEqual(new Set([DEFAULT_EXTENSION_ID]))
    expect(trustedExtensionIds('  ')).toEqual(new Set([DEFAULT_EXTENSION_ID]))
  })

  it('parses a comma-separated override', () => {
    const raw = ` ${'a'.repeat(32)} , ${'p'.repeat(32)} `
    expect(trustedExtensionIds(raw)).toEqual(new Set(['a'.repeat(32), 'p'.repeat(32)]))
  })

  it('refuses a malformed ID, and the listener does not start', async () => {
    expect(() => trustedExtensionIds('not-an-extension-id')).toThrow(/invalid extension id/)
    const log = vi.fn()
    const listener = createSelectionListener({
      host: '127.0.0.1',
      port: 0,
      extensionIds: 'not-an-extension-id',
      version: '1',
      deliver: vi.fn(),
      log,
    })
    await expect(listener.start()).resolves.toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/invalid extension id/))
  })

  it('pins the ID Chrome derives from the manifest key', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../extension/manifest.json'), 'utf8'),
    ) as { key: string }
    const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
    const derived = [...digest.slice(0, 32)]
      .map((ch) => String.fromCharCode(97 + Number.parseInt(ch, 16)))
      .join('')
    expect(derived).toBe(DEFAULT_EXTENSION_ID)
  })
})

describe('host guard', () => {
  it.each([
    '127.0.0.1:PORT',
    '127.0.0.1',
    '127.0.0.2:PORT',
    'localhost:PORT',
    'localhost',
    '[::1]:PORT',
    '[::1]',
  ])('answers a loopback Host (%s)', async (host) => {
    const { send, port } = await start()
    const r = await send('GET', '/health', {
      headers: { host: host.replace('PORT', String(port)) },
    })
    expect(r.status).toBe(200)
  })

  it.each([
    'evil.example',
    'evil.example:PORT',
    '127.0.0.1:9999',
    'localhost.evil.example',
    '[::1',
    '10.0.0.1:PORT',
    '127.0.0.1.evil.example',
  ])('refuses any other Host (%s), before CORS or delivery', async (host) => {
    const { send, post, port, deliver } = await start()
    const header = host.replace('PORT', String(port))
    const health = await send('GET', '/health', { headers: { host: header, origin: EXT } })
    expect(health.status).toBe(403)
    expect(health.json()).toEqual({ detail: 'host not allowed' })
    expect(health.headers['access-control-allow-origin']).toBeUndefined()
    expect((await post('/selection/send', { items: [DOM] }, { host: header })).status).toBe(403)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('refuses a WebSocket upgrade with a rebinding Host', async () => {
    const { send } = await start()
    const r = await send('GET', '/ws', {
      headers: { host: 'evil.example', connection: 'Upgrade', upgrade: 'websocket' },
    }).catch(() => ({ status: 0 }))
    expect([0, 403]).toContain(r.status)
  })
})

describe('body cap', () => {
  const oversized = Buffer.concat([
    Buffer.from('{"items":[{"kind":"dom","snippet":"'),
    Buffer.alloc(MAX_BODY_BYTES, 'x'),
    Buffer.from('"}]}'),
  ])

  it('refuses a body over 1 MiB before delivering anything', async () => {
    const { send, deliver } = await start()
    const r = await send('POST', '/selection/send', {
      headers: { 'content-type': 'application/json' },
      body: oversized,
    })
    expect(r.status).toBe(413)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('refuses an over-cap chunked body with no Content-Length', async () => {
    const { send, deliver } = await start()
    const chunk = Buffer.alloc(65536, 'x')
    const chunks = [
      Buffer.from('{"items":[{"kind":"dom","snippet":"'),
      ...Array.from({ length: MAX_BODY_BYTES / 65536 + 2 }, () => chunk),
      Buffer.from('"}]}'),
    ]
    const r = await send('POST', '/selection/send', {
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body: chunks,
    })
    expect(r.status).toBe(413)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('carries CORS on the 413, so the extension sees the real status', async () => {
    const { send } = await start()
    const r = await send('POST', '/selection/send', {
      headers: { 'content-type': 'application/json', origin: EXT },
      body: oversized,
    })
    expect(r.status).toBe(413)
    expect(r.headers['access-control-allow-origin']).toBe(EXT)
  })
})

describe('content type guard', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/JSON', true],
    ['application/vnd.api+json', true],
    [undefined, true],
    ['text/plain', false],
    ['application/x-www-form-urlencoded', false],
    ['multipart/form-data; boundary=x', false],
    ['application/jsonp', false],
    ['', false],
  ])('%s -> %s', (header, ok) => {
    expect(isJsonContentType(header)).toBe(ok)
  })

  it.each(['text/plain', 'application/x-www-form-urlencoded'])(
    'refuses a %s send with 415 and delivers nothing',
    async (type) => {
      const { send, deliver } = await start()
      const r = await send('POST', '/selection/send', {
        headers: { 'content-type': type },
        body: JSON.stringify({ items: [DOM] }),
      })
      expect(r.status).toBe(415)
      expect(deliver).not.toHaveBeenCalled()
    },
  )

  it('accepts a native send with no Content-Type', async () => {
    const { send, deliver } = await start()
    const r = await send('POST', '/selection/send', { body: JSON.stringify({ items: [DOM] }) })
    expect(r.status).toBe(200)
    expect(deliver).toHaveBeenCalledOnce()
  })
})

describe('POST /selection/send', () => {
  it('delivers the batch and replies {records, count, delivered, reason}', async () => {
    const { post, deliver } = await start()
    const r = await post('/selection/send', {
      items: [
        { kind: 'dom', snippet: '  Save button  ', meta: { type: 'text' }, widget: 'w1' },
        { kind: 'region', snippet: '/tmp/x.png' },
      ],
    })
    expect(r.status).toBe(200)
    const body = r.json() as { records: Array<Record<string, unknown>> }
    expect(body).toMatchObject({ count: 2, delivered: true, reason: null })
    expect(body.records[0]).toMatchObject({
      kind: 'dom',
      snippet: 'Save button',
      meta: { type: 'text' },
      widget: 'w1',
      project: null,
    })
    expect(body.records[0].captured_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(body.records[1]).toMatchObject({ kind: 'region', snippet: '/tmp/x.png', meta: {} })
    expect(deliver).toHaveBeenCalledWith(body.records)
  })

  it('says why a send was not delivered', async () => {
    const { post } = await start(undefined, { delivered: false, reason: 'no_session' })
    const r = await post('/selection/send', { items: [DOM] })
    expect(r.status).toBe(200)
    expect(r.json()).toMatchObject({ count: 1, delivered: false, reason: 'no_session' })
  })

  it.each([
    ['not JSON', '{nope'],
    ['no items', '{}'],
    ['an empty batch', '{"items":[]}'],
    ['too many items', JSON.stringify({ items: Array.from({ length: 51 }, () => DOM) })],
    ['an unknown kind', '{"items":[{"kind":"voice","snippet":"x"}]}'],
    ['a non-string snippet', '{"items":[{"kind":"dom","snippet":5}]}'],
    ['non-object meta', '{"items":[{"kind":"dom","meta":[1]}]}'],
    ['oversized meta', JSON.stringify({ items: [{ kind: 'dom', meta: { a: 'x'.repeat(4001) } }] })],
    ['a long widget label', JSON.stringify({ items: [{ kind: 'dom', widget: 'w'.repeat(201) }] })],
    ['one bad item in a good batch', '{"items":[{"kind":"dom"},{"kind":"bogus"}]}'],
  ])('refuses %s with 422 and delivers nothing', async (_label, body) => {
    const { send, deliver } = await start()
    const r = await send('POST', '/selection/send', {
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(r.status).toBe(422)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('caps the snippet at 2000 characters', async () => {
    const { post } = await start()
    const r = await post('/selection/send', { items: [{ kind: 'dom', snippet: 'y'.repeat(5000) }] })
    expect((r.json() as { records: Array<{ snippet: string }> }).records[0].snippet).toHaveLength(
      2000,
    )
  })
})

describe('routes', () => {
  it('stores nothing: the old history and store-only routes are gone', async () => {
    const { send, post } = await start()
    expect((await send('GET', '/selection/current')).status).toBe(404)
    expect((await send('GET', '/selection/history')).status).toBe(404)
    expect((await send('GET', '/selection/events')).status).toBe(404)
    expect((await post('/selection', DOM)).status).toBe(404)
  })

  it('answers 405 for the wrong method', async () => {
    const { send } = await start()
    expect((await send('GET', '/selection/send')).status).toBe(405)
    expect((await send('POST', '/health')).status).toBe(405)
  })

  it('stops listening on stop()', async () => {
    const { send, listener } = await start()
    listener.stop()
    await expect(send('GET', '/health')).rejects.toThrow()
  })
})
