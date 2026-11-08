import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HttpError,
  listenPrivateSocket,
  onlyFields,
  Router,
  readJsonObject,
  sendError,
  sendJson,
} from './http'

async function withServer<T>(
  router: Router,
  run: (
    call: (
      method: string,
      path: string,
      body?: string,
      type?: string,
    ) => Promise<{ status: number; body: unknown }>,
  ) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-http-'))
  const socket = join(dir, 'a', 'control.sock')
  const server = createServer((req, res) => {
    router.dispatch(req, res).catch((error) => {
      if (error instanceof HttpError) sendError(res, error)
      else sendJson(res, 500, { error: 'internal' })
    })
  })
  await listenPrivateSocket(server, socket)
  const call = (method: string, path: string, body?: string, type = 'application/json') =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        {
          socketPath: socket,
          method,
          path,
          headers: body === undefined ? {} : { 'content-type': type },
        },
        (res) => {
          const parts: Buffer[] = []
          res.on('data', (part: Buffer) => parts.push(part))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(parts).toString('utf8')),
            }),
          )
        },
      )
      req.on('error', reject)
      req.end(body)
    })
  try {
    return await run(call)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('Router and the JSON helpers', () => {
  const router = new Router()
    .add('GET', '/v1/things/:id', (_req, res, params, query) =>
      sendJson(res, 200, { id: params.id, q: query.get('q') }),
    )
    .add('GET', '/v1/files/*', (_req, res, params) => sendJson(res, 200, { rest: params.rest }))
    .add('POST', '/v1/things', async (req, res) => sendJson(res, 201, await readJsonObject(req)))
    .add('POST', '/v1/small', async (req, res) => sendJson(res, 200, await readJsonObject(req, 8)))

  it('matches segments, queries and wildcards, and decodes params', async () => {
    await withServer(router, async (call) => {
      expect(await call('GET', '/v1/things/a%20b?q=1')).toEqual({
        status: 200,
        body: { id: 'a b', q: '1' },
      })
      expect(await call('GET', '/v1/files/x/y.txt')).toEqual({
        status: 200,
        body: { rest: 'x/y.txt' },
      })
    })
  })

  it('answers 404 for no path and 405 for a path with another method, as bare codes', async () => {
    await withServer(router, async (call) => {
      expect(await call('GET', '/v1/nope')).toEqual({ status: 404, body: { error: 'not_found' } })
      expect(await call('DELETE', '/v1/things/1')).toEqual({
        status: 405,
        body: { error: 'method_not_allowed' },
      })
    })
  })

  it('reads a strict JSON object body', async () => {
    await withServer(router, async (call) => {
      expect(await call('POST', '/v1/things', '{"a":1}')).toEqual({ status: 201, body: { a: 1 } })
      expect(await call('POST', '/v1/things', '{"a":1}', 'text/plain')).toEqual({
        status: 415,
        body: { error: 'unsupported_media_type' },
      })
      expect(await call('POST', '/v1/things', '[1]')).toEqual({
        status: 400,
        body: { error: 'invalid_body' },
      })
      expect(await call('POST', '/v1/things', '{bad')).toEqual({
        status: 400,
        body: { error: 'invalid_body' },
      })
      expect(await call('POST', '/v1/small', '{"a":"123456789"}')).toEqual({
        status: 413,
        body: { error: 'body_too_large' },
      })
    })
  })

  it('carries extra fields on an error answer', () => {
    const sent: unknown[] = []
    const response = {
      writeHead: (status: number) => sent.push(status),
      end: (body: string) => sent.push(JSON.parse(body)),
    }
    sendError(response as never, new HttpError(409, 'host_unavailable', { host: 'vm' }))
    expect(sent).toEqual([409, { error: 'host_unavailable', host: 'vm' }])
  })
})

describe('listenPrivateSocket', () => {
  it('makes the directory 0700 and the socket 0600 and replaces a stale socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-http-'))
    const path = join(dir, 'x', 'control.sock')
    const first = createServer()
    await listenPrivateSocket(first, path)
    const { statSync } = await import('node:fs')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'x')).mode & 0o777).toBe(0o700)
    const second = createServer()
    await expect(listenPrivateSocket(second, path)).rejects.toThrow(
      'another daemon is already listening',
    )
    await new Promise((resolve) => first.close(resolve))
  })

  it('refuses to replace a file that is not a socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-http-'))
    const path = join(dir, 'control.sock')
    writeFileSync(path, 'x')
    await expect(listenPrivateSocket(createServer(), path)).rejects.toThrow('non-socket')
  })
})

describe('onlyFields', () => {
  it('passes known fields and names every unknown one in a 400 invalid_body', () => {
    expect(() => onlyFields({ a: 1 }, ['a', 'b'])).not.toThrow()
    expect(() => onlyFields({}, new Set(['a']))).not.toThrow()
    for (const allowed of [['a'], new Set(['a'])]) {
      try {
        onlyFields({ a: 1, x: 2, y: 3 }, allowed)
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError)
        expect(error).toMatchObject({
          status: 400,
          code: 'invalid_body',
          extra: { fields: ['x', 'y'] },
        })
      }
    }
  })
})
