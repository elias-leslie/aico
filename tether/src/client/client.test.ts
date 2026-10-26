import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyStreamEvent,
  compatibleVersion,
  eventSession,
  eventStreamPath,
  followEvents,
  holdGuiChannel,
  knownTetherSockets,
  parseAttachAnswer,
  parseContextHook,
  parseGuiCommand,
  reconnectDelay,
  splitNdjson,
  TetherClient,
  TetherError,
  type TetherEvent,
  TetherPool,
  TetherUnavailable,
  tetherSocketPath,
  trimTrailingSlashes,
} from './index'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function fakeTether(handler: Handler): Promise<{ client: TetherClient; server: Server }> {
  const dir = mkdtempSync(join(tmpdir(), 'tether-client-test-'))
  const socket = join(dir, 'control.sock')
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  cleanups.push(() => {
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { client: new TetherClient(socket, 1_000), server }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
    })
    req.on('end', () => resolve(text ? JSON.parse(text) : null))
  })
}

const event = (seq: number, type: string, bootId = 'boot-a'): TetherEvent => ({
  seq,
  bootId,
  type,
  at: 0,
  data: {},
})

describe('Tether socket path', () => {
  it('prefers TETHER_SOCKET, then the instance under XDG_RUNTIME_DIR', () => {
    expect(tetherSocketPath({ TETHER_SOCKET: '/x/y.sock' }, 1000)).toBe('/x/y.sock')
    expect(tetherSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe(
      '/run/user/1000/tether/default/control.sock',
    )
    expect(tetherSocketPath({ TETHER_INSTANCE: 'dev' }, 1000)).toBe(
      '/run/user/1000/tether/dev/control.sock',
    )
  })
})

describe('version compatibility', () => {
  it('needs API 3 or later that still accepts this Aico', () => {
    const v = { name: 'tether', version: '0.0.1', apiVersion: 3, minApiVersion: 1 }
    expect(compatibleVersion(v)).toBe(true)
    expect(compatibleVersion({ ...v, apiVersion: 1 })).toBe(false)
    expect(compatibleVersion({ ...v, apiVersion: 3, minApiVersion: 2 })).toBe(false)
    expect(compatibleVersion({ ...v, apiVersion: 2 })).toBe(false)
    expect(compatibleVersion({ ...v, apiVersion: 4 })).toBe(true)
  })
})

describe('attach answer', () => {
  const answer = {
    generation: 'a'.repeat(64),
    argv: ['/usr/bin/tmux', '-S', '/x/server.sock', 'attach-session', '-t', '$3'],
    env: { TERM: 'xterm-256color' },
  }

  it("keeps Tether's argv and environment as sent, for the caller to check", () => {
    expect(parseAttachAnswer({ ...answer, unset: ['TMUX'] })).toEqual(answer)
  })

  it('refuses an answer of the wrong shape', () => {
    for (const bad of [null, { ...answer, argv: [1] }, { ...answer, env: { TERM: 1 } }, {}])
      expect(() => parseAttachAnswer(bad)).toThrow(TetherUnavailable)
  })
})

describe('NDJSON and event cursor', () => {
  it('splits complete lines and keeps the partial tail', () => {
    expect(splitNdjson('{"a":1}\n\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    })
  })

  it('resyncs on first hello, gap and daemon restart; drops replayed events', () => {
    let step = applyStreamEvent({ bootId: null, seq: 0 }, event(7, 'hello'))
    expect(step).toEqual({ cursor: { bootId: 'boot-a', seq: 7 }, deliver: false, resync: true })
    step = applyStreamEvent(step.cursor, event(8, 'session.created'))
    expect(step).toMatchObject({ cursor: { seq: 8 }, deliver: true, resync: false })
    expect(applyStreamEvent(step.cursor, event(8, 'session.created')).deliver).toBe(false)
    expect(applyStreamEvent(step.cursor, event(8, 'heartbeat'))).toMatchObject({
      deliver: false,
      resync: false,
    })
    expect(applyStreamEvent(step.cursor, event(8, 'hello')).resync).toBe(false)
    expect(applyStreamEvent(step.cursor, event(20, 'gap')).resync).toBe(true)
    expect(applyStreamEvent(step.cursor, event(1, 'hello', 'boot-b'))).toEqual({
      cursor: { bootId: 'boot-b', seq: 1 },
      deliver: false,
      resync: true,
    })
    expect(eventStreamPath({ bootId: null, seq: 0 })).toBe('/v1/events')
    expect(eventStreamPath({ bootId: 'b', seq: 4 })).toBe('/v1/events?since=4&bootId=b')
  })

  it('backs off exponentially to a cap', () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(2)).toBe(2000)
    expect(reconnectDelay(50)).toBe(10_000)
  })
})

describe('Tether requests', () => {
  it('maps stable error codes and a missing socket', async () => {
    const { client } = await fakeTether((req, res) => {
      if (req.url === '/v1/sessions/0a1b2c3d/end')
        json(res, 409, { error: 'blocked', reason: 'scope cleanup unproven' })
      else json(res, 404, { error: 'not_found' })
    })
    const blocked = await client.end('0a1b2c3d', 'a'.repeat(64)).catch((e: unknown) => e)
    expect(blocked).toBeInstanceOf(TetherError)
    expect(blocked).toMatchObject({
      status: 409,
      code: 'blocked',
      reason: 'scope cleanup unproven',
    })
    await expect(
      new TetherClient('/nonexistent/tether.sock').listSessions(),
    ).rejects.toBeInstanceOf(TetherUnavailable)
  })

  it('creates sessions as origin aico at the view grid and sends exact bodies', async () => {
    const seen: { method?: string; url?: string; body: unknown }[] = []
    const { client } = await fakeTether(async (req, res) => {
      seen.push({ method: req.method, url: req.url, body: await readBody(req) })
      if (req.url === '/v1/sessions') json(res, 202, { id: '0a1b2c3d', status: 'uncertain' })
      else json(res, 200, { delivered: true })
    })
    const created = await client.createSession({
      tool: 'codex',
      projectId: 'aico',
      size: { cols: 100, rows: 30 },
    })
    expect(created).toMatchObject({ id: '0a1b2c3d', status: 'uncertain' })
    await client.inject('0a1b2c3d', 'b'.repeat(64), '[dom: "x"] ', 'type')
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/sessions',
        body: { tool: 'codex', projectId: 'aico', size: { cols: 100, rows: 30 }, origin: 'aico' },
      },
      {
        method: 'POST',
        url: '/v1/sessions/0a1b2c3d/inject',
        body: { generation: 'b'.repeat(64), text: '[dom: "x"] ', mode: 'type' },
      },
    ])
  })
})

describe('resize claim', () => {
  it('sends the viewer label when given, and reads the holder back', async () => {
    const seen: { method?: string; url?: string; body: unknown }[] = []
    const holder = {
      clientPid: 7,
      cols: 80,
      rows: 24,
      generation: 'g',
      claimedAt: 'now',
      viewer: { app: 'desktop', device: 'box' },
    }
    const { client } = await fakeTether(async (req, res) => {
      seen.push({ method: req.method, url: req.url, body: await readBody(req) })
      if (req.method === 'GET') json(res, 200, { generation: 'g', holder })
      else json(res, 200, { applied: true, changed: false })
    })
    const viewer = { app: 'desktop', device: 'box' }
    expect(await client.resizeClaim('0a1b2c3d', 'g', 7, 80, 24, viewer)).toEqual({
      applied: true,
      changed: false,
    })
    await client.resizeClaim('0a1b2c3d', 'g', 7, 80, 24)
    expect(await client.resizeHolder('0a1b2c3d')).toEqual({ generation: 'g', holder })
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/sessions/0a1b2c3d/resize-claim',
        body: { generation: 'g', clientPid: 7, cols: 80, rows: 24, viewer },
      },
      {
        method: 'POST',
        url: '/v1/sessions/0a1b2c3d/resize-claim',
        body: { generation: 'g', clientPid: 7, cols: 80, rows: 24 },
      },
      { method: 'GET', url: '/v1/sessions/0a1b2c3d/resize-claim', body: null },
    ])
  })
})

describe('post-cutover routes', () => {
  it('switches to a project or a plain root and re-checks context', async () => {
    const seen: { method?: string; url?: string; body: unknown }[] = []
    const { client } = await fakeTether(async (req, res) => {
      seen.push({ method: req.method, url: req.url, body: await readBody(req) })
      if (req.url?.endsWith('/context-check'))
        json(res, 200, {
          generation: 'g',
          contextHook: {
            state: 'available',
            detail: 'ok',
            tool: 'codex',
            applicable: true,
            checkedAt: 5,
          },
        })
      else json(res, 200, { id: '0a1b2c3d' })
    })
    const generation = 'c'.repeat(64)
    await client.switchProject('0a1b2c3d', generation, { projectId: 'aico' })
    await client.switchProject('0a1b2c3d', generation, { projectRoot: '/home/u/pw' })
    expect(await client.contextCheck('0a1b2c3d')).toEqual({
      state: 'available',
      detail: 'ok',
      tool: 'codex',
      applicable: true,
      checkedAt: 5,
    })
    expect(seen.map(({ method, url, body }) => [method, url, body])).toEqual([
      ['POST', '/v1/sessions/0a1b2c3d/switch-project', { generation, projectId: 'aico' }],
      ['POST', '/v1/sessions/0a1b2c3d/switch-project', { generation, projectRoot: '/home/u/pw' }],
      ['POST', '/v1/sessions/0a1b2c3d/context-check', null],
    ])
  })

  it('reads odd context answers safely', () => {
    expect(parseContextHook(undefined)).toBeNull()
    expect(parseContextHook({ state: 'unknown', detail: '', tool: 'shell' })).toBeNull()
  })

  it('takes the session snapshot from an event only when it matches the id', () => {
    const session = {
      id: '0a1b2c3d',
      generation: 'g',
      status: 'running',
      tool: 'codex',
      createdAt: 1,
      tmux: { sessionName: 'aico-0a1b2c3d' },
    }
    const updated = (data: Record<string, unknown>): TetherEvent => ({
      ...event(1, 'session.updated'),
      data,
    })
    expect(eventSession(updated({ id: '0a1b2c3d', generation: 'g', session }))).toEqual(session)
    expect(eventSession(updated({ id: 'ffffffff', session }))).toBeNull()
    expect(eventSession(updated({ id: '0a1b2c3d', generation: 'g' }))).toBeNull()
    expect(
      eventSession(updated({ id: '0a1b2c3d', session: { ...session, tmux: null } })),
    ).toBeNull()
  })
})

describe('event stream', () => {
  it('reconnects with since/bootId and re-lists on a gap', async () => {
    const urls: string[] = []
    let connection = 0
    const { client } = await fakeTether((req, res) => {
      urls.push(req.url ?? '')
      connection += 1
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      if (connection === 1) {
        res.write(`${JSON.stringify(event(3, 'hello'))}\n`)
        res.end(`${JSON.stringify({ ...event(4, 'session.ended'), data: { id: '0a1b2c3d' } })}\n`)
      } else {
        res.write(`${JSON.stringify(event(9, 'hello'))}\n`)
        res.write(`${JSON.stringify(event(9, 'gap'))}\n`)
      }
    })
    const seen: string[] = []
    let resyncs = 0
    const stop = followEvents(client, {
      onResync: () => {
        resyncs += 1
      },
      onEvent: (e) => seen.push(`${e.type}:${String(e.data.id)}`),
    })
    cleanups.push(stop)
    await expect.poll(() => connection, { timeout: 3_000 }).toBe(2)
    await expect.poll(() => resyncs).toBe(2)
    expect(seen).toEqual(['session.ended:0a1b2c3d'])
    expect(urls).toEqual(['/v1/events', '/v1/events?since=4&bootId=boot-a'])
  })
})

describe('GUI channel', () => {
  it('parses only well-formed commands', () => {
    expect(parseGuiCommand({ type: 'command', commandId: 'layout-1', kind: 'layout' })).toEqual({
      commandId: 'layout-1',
      kind: 'layout',
    })
    const base = { type: 'command', commandId: 'c1', sessionId: '0a1b2c3d', generation: 'g' }
    expect(parseGuiCommand({ ...base, kind: 'show' })).toEqual({
      commandId: 'c1',
      kind: 'show',
      sessionId: '0a1b2c3d',
      generation: 'g',
    })
    expect(parseGuiCommand({ ...base, kind: 'show', ifViewed: true })).toMatchObject({
      ifViewed: true,
    })
    expect(parseGuiCommand({ ...base, kind: 'show', ifViewed: 'yes' })).not.toHaveProperty(
      'ifViewed',
    )
    expect(
      parseGuiCommand({
        ...base,
        kind: 'position',
        bounds: { x: 1, y: 2, width: 900, height: 600 },
      }),
    ).toMatchObject({ bounds: { x: 1, y: 2, width: 900, height: 600 } })
    expect(parseGuiCommand({ ...base, kind: 'position', bounds: { x: 1.5 } })).toBeNull()
    expect(parseGuiCommand({ ...base, kind: 'title' })).toBeNull()
    expect(parseGuiCommand({ ...base, kind: 'coordinator', coordinator: true })).toMatchObject({
      coordinator: true,
    })
    expect(parseGuiCommand({ ...base, kind: 'coordinator', coordinator: 'yes' })).toBeNull()
    expect(parseGuiCommand({ ...base, kind: 'coordinator' })).toBeNull()
    expect(parseGuiCommand({ ...base, kind: 'show', sessionId: '../x' })).toBeNull()
    expect(parseGuiCommand({ type: 'heartbeat' })).toBeNull()
  })

  it('identifies as aico-gui, applies commands and posts each verdict', async () => {
    const results: { url?: string; body: unknown }[] = []
    let header: string | undefined
    const { client } = await fakeTether(async (req, res) => {
      if (req.url === '/v1/gui/channel') {
        header = req.headers['x-tether-client'] as string
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ type: 'hello' })}\n`)
        for (const [commandId, kind] of [
          ['c1', 'show'],
          ['c2', 'title'],
        ])
          res.write(
            `${JSON.stringify({ type: 'command', commandId, kind, sessionId: '0a1b2c3d', generation: 'g', label: 'Focus' })}\n`,
          )
        return
      }
      results.push({ url: req.url, body: await readBody(req) })
      json(res, 200, { accepted: true })
    })
    const stop = holdGuiChannel(client, async (command) =>
      command.kind === 'show' ? { applied: true } : { applied: false, error: 'stale_generation' },
    )
    cleanups.push(stop)
    await expect.poll(() => results.length, { timeout: 3_000 }).toBe(2)
    expect(header).toBe('aico-gui')
    expect(results).toContainEqual({ url: '/v1/gui/results/c1', body: { applied: true } })
    expect(results).toContainEqual({
      url: '/v1/gui/results/c2',
      body: { applied: false, error: 'stale_generation' },
    })
  })

  it('posts the GUI snapshot a layout request collected', async () => {
    const snapshot = { windows: [] }
    const results: unknown[] = []
    const { client } = await fakeTether(async (req, res) => {
      if (req.url === '/v1/gui/channel') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ type: 'command', commandId: 'layout-1', kind: 'layout' })}\n`)
        return
      }
      expect(req.url).toBe('/v1/gui/results/layout-1')
      results.push(await readBody(req))
      json(res, 200, { accepted: true })
    })
    cleanups.push(
      holdGuiChannel(client, async (command) =>
        command.kind === 'layout'
          ? { applied: true, layout: snapshot }
          : { applied: false, error: 'invalid_body' },
      ),
    )
    await expect.poll(() => results.length).toBe(1)
    expect(results).toEqual([{ applied: true, layout: snapshot }])
  })

  it('answers a malformed command with invalid_body instead of letting Tether time out', async () => {
    const results: { url?: string; body: unknown }[] = []
    const applied: string[] = []
    const { client } = await fakeTether(async (req, res) => {
      if (req.url === '/v1/gui/channel') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        // Unknown kind from a newer Tether, a bad session id, then one with no
        // usable commandId (nothing to answer), then a good one.
        const show = { type: 'command', kind: 'show', sessionId: '0a1b2c3d', generation: 'g' }
        for (const line of [
          { ...show, commandId: 'c1', kind: 'resize' },
          { ...show, commandId: 'c2', sessionId: '../x' },
          { ...show, commandId: 7 },
          { ...show, commandId: 'c3' },
        ])
          res.write(`${JSON.stringify(line)}\n`)
        return
      }
      results.push({ url: req.url, body: await readBody(req) })
      json(res, 200, { accepted: true })
    })
    const stop = holdGuiChannel(client, async (command) => {
      applied.push(command.commandId)
      return { applied: true }
    })
    cleanups.push(stop)
    await expect.poll(() => results.length, { timeout: 3_000 }).toBe(3)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(applied).toEqual(['c3'])
    expect(results).toHaveLength(3)
    expect(results).toContainEqual({
      url: '/v1/gui/results/c1',
      body: { applied: false, error: 'invalid_body' },
    })
    expect(results).toContainEqual({
      url: '/v1/gui/results/c2',
      body: { applied: false, error: 'invalid_body' },
    })
    expect(results).toContainEqual({ url: '/v1/gui/results/c3', body: { applied: true } })
  })

  it('stops for good when another GUI supersedes it', async () => {
    let connections = 0
    const { client } = await fakeTether((_req, res) => {
      connections += 1
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(`${JSON.stringify({ type: 'superseded' })}\n`)
    })
    const stop = holdGuiChannel(client, async () => ({ applied: true }))
    cleanups.push(stop)
    await expect.poll(() => connections).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(connections).toBe(1)
  })
})

describe('two Tether instances', () => {
  const own = '/run/user/1000/tether/default/control.sock'

  it('consults only the active instance', () => {
    expect(knownTetherSockets({}, 1000)).toEqual([own])
    expect(knownTetherSockets({ TETHER_INSTANCE: 'dev' }, 1000)).toEqual([
      '/run/user/1000/tether/dev/control.sock',
    ])
    expect(knownTetherSockets({ TETHER_SOCKET: '/x/y.sock' }, 1000)).toEqual(['/x/y.sock'])
  })

  async function pair() {
    const seen: string[] = []
    const make = async (name: string, sessions: string[]) =>
      await fakeTether(async (req, res) => {
        seen.push(`${name} ${req.method} ${req.url}`)
        if (req.url === '/v1/sessions' && req.method === 'GET')
          return json(res, 200, { items: sessions.map((id) => ({ id })) })
        if (req.url === '/v1/sessions' && req.method === 'POST')
          return json(res, 201, { id: `${name}-new` })
        const id = req.url?.split('/')[3]
        if (id && sessions.includes(id)) return json(res, 200, { id, owner: name })
        json(res, 404, { error: 'not_found' })
      })
    const active = await make('own', ['aaaaaaaa'])
    const other = await make('agent', ['bbbbbbbb'])
    return { active: active.client, other: other.client, otherServer: other.server, seen }
  }

  it('lists both, creates on the active one and asks the owning instance by id', async () => {
    const { active, other, seen } = await pair()
    const pool = new TetherPool([active.socketPath, other.socketPath], 1_000)
    expect((await pool.listSessions()).map((s) => s.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect((await pool.createSession({ tool: 'shell', size: { cols: 80, rows: 24 } })).id).toBe(
      'own-new',
    )
    expect(await pool.getSession('bbbbbbbb')).toEqual({ id: 'bbbbbbbb', owner: 'agent' })
    expect(seen.filter((line) => line.includes('POST'))).toEqual(['own POST /v1/sessions'])
    await expect(pool.getSession('cccccccc')).rejects.toMatchObject({ status: 404 })
    expect(pool.instances().map((c) => c.socketPath)).toEqual([active.socketPath, other.socketPath])
  })

  it('treats a missing other socket as absent', async () => {
    const { active } = await pair()
    const missing = join(tmpdir(), 'aico-no-such.sock')
    const alone = new TetherPool([active.socketPath, missing], 1_000)
    expect((await alone.listSessions()).map((s) => s.id)).toEqual(['aaaaaaaa'])
    await expect(alone.getSession('zzzzzzzz')).rejects.toMatchObject({ status: 404 })
  })

  it('keeps the active sessions after a previously seen secondary stops', async () => {
    const { active, other, otherServer } = await pair()
    const pool = new TetherPool([active.socketPath, other.socketPath], 1_000)
    expect(await pool.listSessions()).toHaveLength(2)
    await new Promise<void>((resolve, reject) =>
      otherServer.close((error) => (error ? reject(error) : resolve())),
    )
    expect((await pool.listSessions()).map((s) => s.id)).toEqual(['aaaaaaaa'])
  })

  it('keeps active sessions during a secondary outage while session lookup reports it', async () => {
    const { active, other } = await pair()
    let up = true
    const pool = new TetherPool([active.socketPath, other.socketPath], 1_000, () => up)
    expect(await pool.listSessions()).toHaveLength(2)
    pool.instances()[1].request = () => Promise.reject(new TetherUnavailable('down'))
    expect((await pool.listSessions()).map((s) => s.id)).toEqual(['aaaaaaaa'])
    await expect(pool.getSession('cccccccc')).rejects.toBeInstanceOf(TetherUnavailable)
    up = false
    expect((await pool.listSessions()).map((s) => s.id)).toEqual(['aaaaaaaa'])
  })

  it('still reports an unavailable active instance and secondary API errors', async () => {
    const { active, other } = await pair()
    const pool = new TetherPool([active.socketPath, other.socketPath], 1_000)
    pool.instances()[1].request = () => Promise.reject(new TetherError(500, 'broken', {}))
    await expect(pool.listSessions()).rejects.toMatchObject({ status: 500, code: 'broken' })
    pool.instances()[0].request = () => Promise.reject(new TetherUnavailable('active down'))
    await expect(pool.listSessions()).rejects.toBeInstanceOf(TetherUnavailable)
  })
})

describe('trimTrailingSlashes', () => {
  it('drops only trailing slashes', () => {
    expect(trimTrailingSlashes('/v1/sessions//')).toBe('/v1/sessions')
    expect(trimTrailingSlashes('/v1/sessions')).toBe('/v1/sessions')
    expect(trimTrailingSlashes('///')).toBe('')
  })

  it('stays linear on a long run of slashes', () => {
    const started = performance.now()
    expect(trimTrailingSlashes(`${'/'.repeat(200_000)}x`)).toHaveLength(200_001)
    expect(performance.now() - started).toBeLessThan(200)
  })
})
