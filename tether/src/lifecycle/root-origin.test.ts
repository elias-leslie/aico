import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listenPrivateSocket } from '../http'
import { opensRootWindow } from '../lifecycle-api'
import { getWidget, removeWidget } from './catalog'
import { createRootHandler, parseRootCreate, type RootControlOperations } from './root-control'
import { initStore, registerBuiltinTuis } from './testing'

const WEB_SESSION_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'

describe('root origin (v1 roots API)', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tether-root-origin-'))
  const v1Socket = join(fixture, 'v1', 'control.sock')
  const legacySocket = join(fixture, 'aico', 'gui-control.sock')
  const operations: RootControlOperations = {
    available: () => true,
    validate: () => true,
    ensure: async () => {},
    status: async () => 'running',
    mutate: async () => true,
  }
  const servers: Server[] = []
  const serve = (ownerFromOrigin: boolean): Server => {
    const handle = createRootHandler(operations, { ownerFromOrigin })
    const server = createServer((req, res) => {
      void handle(req, res)
    })
    servers.push(server)
    return server
  }
  beforeAll(async () => {
    registerBuiltinTuis()
    initStore(join(fixture, 'catalog.db'))
    await listenPrivateSocket(serve(true), v1Socket)
    await listenPrivateSocket(serve(false), legacySocket)
  })
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
    rmSync(fixture, { recursive: true, force: true })
  })

  const call = (
    socket: string,
    path: string,
    method = 'GET',
    payload?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const client = request({ socketPath: socket, path, method }, (response) => {
        let text = ''
        response.on('data', (part: Buffer) => {
          text += part.toString('utf8')
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }),
        )
      })
      client.once('error', reject)
      client.end(payload === undefined ? undefined : JSON.stringify(payload))
    })
  const create = (requestId: string, extra: Record<string, unknown> = {}) => ({
    requestId,
    tool: 'codex',
    projectId: 'sample-app',
    projectRoot: fixture,
    initialPrompt: 'Only this root.',
    role: 'lead',
    workRole: 'implementation',
    leadRootReference: null,
    ...extra,
  })

  it('refuses a tool it cannot start as a root by name, listing the ones it can', async () => {
    for (const socket of [v1Socket, legacySocket])
      for (const tool of ['shell', 'claude', 'aider'])
        expect(await call(socket, '/v1/roots', 'POST', create('t', { tool }))).toEqual({
          status: 400,
          body: {
            error: 'unsupported_tool',
            supported: ['claude-code', 'codex', 'pi'],
          },
        })
    // A malformed tool value is just a bad body.
    expect((await call(v1Socket, '/v1/roots', 'POST', create('t', { tool: 7 }))).body).toEqual({
      error: 'invalid_body',
    })
    expect(parseRootCreate(create('a', { tool: 'claude-code' }))?.tool).toBe('claude-code')
  })

  it('accepts origin and a web app session id only together', () => {
    expect(parseRootCreate(create('a'))?.origin).toBe('aico')
    expect(
      parseRootCreate(create('a', { origin: 'a-term', aTermSessionId: WEB_SESSION_ID })),
    ).toMatchObject({ origin: 'a-term', aTermSessionId: WEB_SESSION_ID })
    expect(parseRootCreate(create('a', { origin: 'other' }))).toBeNull()
    expect(parseRootCreate(create('a', { aTermSessionId: WEB_SESSION_ID }))).toBeNull()
    expect(parseRootCreate(create('a', { origin: 'a-term', aTermSessionId: 'x' }))).toBeNull()
  })

  it('stores origin, reports it as owner, and filters by it', async () => {
    const web = await call(
      v1Socket,
      '/v1/roots',
      'POST',
      create('from-web', { origin: 'a-term', aTermSessionId: WEB_SESSION_ID }),
    )
    expect(web.body).toMatchObject({ owner: 'a-term', origin: 'a-term' })
    const session = getWidget(web.body.hostIdentity as string)
    expect(session).toMatchObject({ origin: 'a-term', aTermSessionId: WEB_SESSION_ID })
    const aico = await call(v1Socket, '/v1/roots', 'POST', create('from-aico'))
    expect(aico.body).toMatchObject({ owner: 'aico', origin: 'aico' })

    const filtered = await call(v1Socket, '/v1/roots?origin=a-term')
    expect(filtered.body.owner).toBe('a-term')
    expect((filtered.body.roots as { requestId: string }[]).map((r) => r.requestId)).toEqual([
      'from-web',
    ])
    expect((await call(v1Socket, '/v1/roots?origin=x')).body).toEqual({ error: 'invalid_query' })
  })

  it('keeps the legacy Aico wire format unchanged', async () => {
    const root = await call(legacySocket, '/v1/roots/from-web')
    expect(root.body.owner).toBe('aico')
    expect(root.body).not.toHaveProperty('origin')
  })

  it('lists without tombstones on ended=0 on both sockets, keeping them by id', async () => {
    const ended = await call(v1Socket, '/v1/roots', 'POST', create('ended-root'))
    removeWidget(ended.body.hostIdentity as string)
    const ids = (body: Record<string, unknown>) =>
      (body.roots as { requestId: string }[]).map((r) => r.requestId)
    for (const socket of [v1Socket, legacySocket]) {
      expect(ids((await call(socket, '/v1/roots')).body)).toContain('ended-root')
      expect(ids((await call(socket, '/v1/roots?ended=0')).body)).not.toContain('ended-root')
      expect(ids((await call(socket, '/v1/roots?ended=0')).body)).toContain('from-aico')
      expect((await call(socket, '/v1/roots?ended=no')).status).toBe(400)
      expect((await call(socket, '/v1/roots/ended-root')).body).toMatchObject({
        status: 'ended',
        generation: null,
      })
    }
  })
})

describe('root windows', () => {
  it('opens a window for desktop and st aico create roots, never for web roots', () => {
    expect(opensRootWindow({ origin: 'root' })).toBe(true)
    expect(opensRootWindow({ origin: 'a-term' })).toBe(false)
  })
})
