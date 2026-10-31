import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listenPrivateSocket } from '../http'
import { adoptLineage, getWidget, removeWidget } from './catalog'
import { createRootHandler, parseRootCreate, type RootControlOperations } from './root-control'
import { initStore, registerBuiltinTuis } from './testing'

const WEB_SESSION_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'

describe('root origin (v1 roots API)', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tether-root-origin-'))
  const v1Socket = join(fixture, 'v1', 'control.sock')
  const remoteBodies: Record<string, unknown>[] = []
  const operations: RootControlOperations = {
    available: () => true,
    validate: () => true,
    ensure: async () => {},
    status: async () => 'running',
    mutate: async () => true,
    adopt: (widgetId, lineage) => adoptLineage(widgetId, lineage),
    agentExit: (row) => (row.tool === 'pi' ? { status: 1 } : null),
    refuse: async (request) =>
      request.model === 'nope/nope'
        ? { status: 422, error: 'unknown_model', reason: 'pi on vm has no model nope/nope' }
        : null,
    remote: async (body, response) => {
      remoteBodies.push(body)
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ forwarded: body.host }))
    },
    // Stub placement: 1 byte fits here, 2 on vm, anything else is at capacity.
    // A named host keeps its name ('local' = here).
    place: async (requestId, needs, pool, host) => {
      placeCalls.push(requestId)
      placePools.push(pool)
      placeHosts.push(host)
      const mem = (needs as { memBytes?: unknown } | undefined)?.memBytes
      if (mem === 1 || mem === 2)
        return {
          kind: 'placed',
          host: host !== undefined ? (host === 'local' ? null : host) : mem === 1 ? null : 'vm',
          done: () => placeDone.push(requestId),
        }
      return {
        kind: 'refused',
        status: 409,
        body: { error: 'at_capacity', hosts: [{ host: 'local', reason: 'needs more' }] },
      }
    },
  }
  const placeCalls: string[] = []
  const placePools: unknown[] = []
  const placeHosts: unknown[] = []
  const placeDone: string[] = []
  const handle = createRootHandler(operations)
  const server = createServer((req, res) => {
    void handle(req, res)
  })
  beforeAll(async () => {
    registerBuiltinTuis()
    initStore(join(fixture, 'catalog.db'))
    await listenPrivateSocket(server, v1Socket)
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
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
    for (const tool of ['shell', 'claude', 'aider'])
      expect(await call(v1Socket, '/v1/roots', 'POST', create('t', { tool }))).toEqual({
        status: 400,
        body: {
          error: 'unsupported_tool',
          supported: ['agent-hub', 'claude-code', 'codex', 'pi'],
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
    expect(aico.body).toMatchObject({ owner: 'aico', origin: 'aico', agentExit: null })

    const filtered = await call(v1Socket, '/v1/roots?origin=a-term')
    expect(filtered.body.owner).toBe('a-term')
    expect((filtered.body.roots as { requestId: string }[]).map((r) => r.requestId)).toEqual([
      'from-web',
    ])
    expect((await call(v1Socket, '/v1/roots?origin=x')).body).toEqual({ error: 'invalid_query' })
  })

  it('hands a create naming a host to the hub, and records a foreign lineage', async () => {
    expect(await call(v1Socket, '/v1/roots', 'POST', create('remote', { host: 'vm' }))).toEqual({
      status: 202,
      body: { forwarded: 'vm' },
    })
    expect(remoteBodies).toEqual([expect.objectContaining({ requestId: 'remote', host: 'vm' })])
    const lineage = { coordinatorId: 'abcd1234', coordinatorColor: '#6fa8ff' }
    const lane = await call(v1Socket, '/v1/roots', 'POST', create('lane', { lineage }))
    expect(getWidget(lane.body.hostIdentity as string)).toMatchObject({
      coordinatorId: 'abcd1234',
      coordinatorColor: '#6fa8ff',
    })
    expect(parseRootCreate(create('a', { host: null }))?.requestId).toBe('a')
    expect(parseRootCreate(create('a', { lineage, launchedBy: 'abcd1234' }))).toBeNull()
    expect(parseRootCreate(create('a', { lineage: { coordinatorId: 'nope' } }))).toBeNull()
    expect(parseRootCreate(create('a', { lineage: { ...lineage, extra: 1 } }))).toBeNull()
    // A launcher on the other machine (9) is the new session's parent.
    const nested = { ...lineage, parentId: 'abcd5678' }
    const helper = await call(v1Socket, '/v1/roots', 'POST', create('helper', { lineage: nested }))
    expect(getWidget(helper.body.hostIdentity as string)).toMatchObject({
      coordinatorId: 'abcd1234',
      parentId: 'abcd5678',
    })
    expect(parseRootCreate(create('a', { lineage: { ...lineage, parentId: 'nope' } }))).toBeNull()
  })

  it('refuses a bad option for a host the way a local create does, before the hub', async () => {
    const before = remoteBodies.length
    const refusals: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { tool: 'pi' },
        { error: 'invalid_body', field: 'model', reason: 'pi needs --model provider/model' },
      ],
      [
        { tool: 'pi', model: 'deepseek-v4.1-flash' },
        { error: 'invalid_body', field: 'model', reason: 'pi needs --model provider/model' },
      ],
      [{ tool: 'codex', model: 'gpt 6' }, { error: 'invalid_body' }],
      [{ tool: 'codex', reasoningEffort: 'turbo' }, { error: 'invalid_body' }],
      [{ tool: 'pi', model: 'opencode-go/x', reasoningEffort: 'none' }, { error: 'invalid_body' }],
      [{ tool: 'shell' }, expect.objectContaining({ error: 'unsupported_tool' })],
    ]
    for (const [extra, body] of refusals) {
      const local = await call(v1Socket, '/v1/roots', 'POST', create('bad-opt', extra))
      const remote = await call(
        v1Socket,
        '/v1/roots',
        'POST',
        create('bad-opt', { ...extra, host: 'vm' }),
      )
      expect(local).toEqual({ status: 400, body })
      expect(remote).toEqual(local)
    }
    expect(remoteBodies).toHaveLength(before)
    const good = { tool: 'pi', model: 'opencode-go/deepseek-v4.1-flash', reasoningEffort: 'low' }
    expect(
      (await call(v1Socket, '/v1/roots', 'POST', create('good-opt', { ...good, host: 'vm' })))
        .status,
    ).toBe(202)
    expect(remoteBodies.at(-1)).toMatchObject({ ...good, host: 'vm' })
    // Here, the same pi starts, and its root says how the agent ended.
    expect((await call(v1Socket, '/v1/roots', 'POST', create('good-pi', good))).body).toMatchObject(
      { status: 'running', agentExit: { status: 1 } },
    )
  })

  it('places host auto by its needs: here, on a host, or at capacity', async () => {
    const here = await call(
      v1Socket,
      '/v1/roots',
      'POST',
      create('auto-here', { host: 'auto', needs: { memBytes: 1 } }),
    )
    expect(here).toMatchObject({ status: 200, body: { requestId: 'auto-here', status: 'running' } })
    expect(getWidget(here.body.hostIdentity as string)).toBeDefined()
    const before = remoteBodies.length
    const there = await call(
      v1Socket,
      '/v1/roots',
      'POST',
      create('auto-vm', { host: 'auto', needs: { memBytes: 2 } }),
    )
    expect(there).toEqual({ status: 202, body: { forwarded: 'vm' } })
    // The host gets the create without needs, named like any --host create.
    expect(remoteBodies.slice(before)).toEqual([
      expect.not.objectContaining({ needs: expect.anything() }),
    ])
    expect(remoteBodies.at(-1)).toMatchObject({ requestId: 'auto-vm', host: 'vm' })
    expect(placeDone).toEqual(['auto-here', 'auto-vm'])
    expect(
      await call(v1Socket, '/v1/roots', 'POST', create('auto-full', { host: 'auto', needs: {} })),
    ).toEqual({
      status: 409,
      body: { error: 'at_capacity', hosts: [{ host: 'local', reason: 'needs more' }] },
    })
    expect((await call(v1Socket, '/v1/roots/auto-full')).status).toBe(404)
    // A bad option is refused before placement; needs only go with host auto.
    const calls = placeCalls.length
    expect(
      (await call(v1Socket, '/v1/roots', 'POST', create('auto-bad', { host: 'auto', tool: 7 })))
        .status,
    ).toBe(400)
    expect(placeCalls).toHaveLength(calls)
    expect(
      await call(v1Socket, '/v1/roots', 'POST', create('needs-alone', { needs: { memBytes: 1 } })),
    ).toEqual({ status: 400, body: { error: 'invalid_body' } })
  })

  it('hands placement the pool, keeps it off the host, and takes it only with host auto', async () => {
    const before = remoteBodies.length
    const there = await call(
      v1Socket,
      '/v1/roots',
      'POST',
      create('auto-pool', { host: 'auto', pool: 'neri-hunt', needs: { memBytes: 2 } }),
    )
    expect(there).toEqual({ status: 202, body: { forwarded: 'vm' } })
    expect(placePools.at(-1)).toBe('neri-hunt')
    expect(remoteBodies.slice(before)).toEqual([
      expect.not.objectContaining({ pool: expect.anything(), needs: expect.anything() }),
    ])
    const calls = placeCalls.length
    expect(
      await call(v1Socket, '/v1/roots', 'POST', create('pool-alone', { pool: 'neri-hunt' })),
    ).toEqual({
      status: 400,
      body: { error: 'invalid_body', field: 'pool', reason: 'pool goes with host "auto"' },
    })
    expect(placeCalls).toHaveLength(calls)
  })

  it('rechecks and reserves a named host with needs, and sends the host no needs', async () => {
    const before = remoteBodies.length
    const there = await call(
      v1Socket,
      '/v1/roots',
      'POST',
      create('named-box', { host: 'box', needs: { memBytes: 2 } }),
    )
    expect(there).toEqual({ status: 202, body: { forwarded: 'box' } })
    expect(placeCalls.at(-1)).toBe('named-box')
    expect(placeHosts.at(-1)).toBe('box')
    expect(placePools.at(-1)).toBeUndefined()
    expect(remoteBodies.slice(before)).toEqual([
      expect.not.objectContaining({ needs: expect.anything() }),
    ])
    expect(remoteBodies.at(-1)).toMatchObject({ requestId: 'named-box', host: 'box' })
    expect(placeDone.at(-1)).toBe('named-box')
    // No room there: the refusal goes back and nothing is sent to the host.
    const sent = remoteBodies.length
    expect(
      await call(
        v1Socket,
        '/v1/roots',
        'POST',
        create('named-full', { host: 'box', needs: { memBytes: 9 } }),
      ),
    ).toEqual({
      status: 409,
      body: { error: 'at_capacity', hosts: [{ host: 'local', reason: 'needs more' }] },
    })
    expect(remoteBodies).toHaveLength(sent)
    // `local` with needs starts here; a named host without needs is not placed.
    const here = await call(
      v1Socket,
      '/v1/roots',
      'POST',
      create('named-here', { host: 'local', needs: { memBytes: 1 } }),
    )
    expect(here).toMatchObject({ status: 200, body: { requestId: 'named-here' } })
    const calls = placeCalls.length
    await call(v1Socket, '/v1/roots', 'POST', create('named-plain', { host: 'box' }))
    expect(placeCalls).toHaveLength(calls)
    expect(remoteBodies.at(-1)).toMatchObject({ requestId: 'named-plain', host: 'box' })
    // pool still goes only with auto.
    expect(
      (
        await call(
          v1Socket,
          '/v1/roots',
          'POST',
          create('named-pool', { host: 'box', pool: 'hunt', needs: { memBytes: 2 } }),
        )
      ).body,
    ).toMatchObject({ field: 'pool' })
  })

  it('passes on the reason a refusal gives, and reserves nothing', async () => {
    const pi = create('pi-bogus', { tool: 'pi', model: 'nope/nope' })
    expect(await call(v1Socket, '/v1/roots', 'POST', pi)).toEqual({
      status: 422,
      body: { error: 'unknown_model', reason: 'pi on vm has no model nope/nope' },
    })
    expect((await call(v1Socket, '/v1/roots/pi-bogus')).status).toBe(404)
  })

  it('lists without tombstones on ended=0, keeping them by id', async () => {
    const ended = await call(v1Socket, '/v1/roots', 'POST', create('ended-root'))
    removeWidget(ended.body.hostIdentity as string)
    const ids = (body: Record<string, unknown>) =>
      (body.roots as { requestId: string }[]).map((r) => r.requestId)
    expect(ids((await call(v1Socket, '/v1/roots')).body)).toContain('ended-root')
    expect(ids((await call(v1Socket, '/v1/roots?ended=0')).body)).not.toContain('ended-root')
    expect(ids((await call(v1Socket, '/v1/roots?ended=0')).body)).toContain('from-aico')
    expect((await call(v1Socket, '/v1/roots?ended=no')).status).toBe(400)
    expect((await call(v1Socket, '/v1/roots/ended-root')).body).toMatchObject({
      status: 'ended',
      generation: null,
    })
  })
})
