import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GuiOutcome } from '../gui-channel'
import { HttpError, readJsonObject, sendError, sendJson } from '../http'
import { Hub, type HubDeps } from './hub'
import { peerRequest } from './peer-http'

type Item = Record<string, unknown> & { id: string }

function session(id: string, extra: Record<string, unknown> = {}): Item {
  return {
    id,
    generation: `gen-${id}`,
    status: 'running',
    tool: 'shell',
    projectId: 'p',
    origin: 'aico',
    rootRequestId: null,
    tmux: { socket: '/home/u/.local/state/tether/default/tmux/x/server.sock' },
    createdAt: 1,
    wakes: [],
    ...extra,
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(part as Buffer)
  const text = Buffer.concat(parts).toString('utf8')
  return text ? JSON.parse(text) : null
}

/** A stand-in remote Tether on the link's forwarded socket. */
class FakePeer {
  server: Server | null = null
  sessions: Item[] = []
  identity: Record<string, unknown> = { name: 'vm-1', machineId: 'aaaa' }
  requests: { method: string; url: string; body: unknown }[] = []
  failSessions = false
  /** Health never answers (a VM that stopped dead: the socket takes the
   * connection, nothing comes back). */
  hangHealth = false
  readonly streams = new Set<ServerResponse>()
  gui: ServerResponse | null = null
  roots: Record<string, unknown>[] = []
  guiResults: { id: string; body: unknown }[] = []

  constructor(readonly socket: string) {}

  async start(): Promise<void> {
    try {
      unlinkSync(this.socket)
    } catch {}
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server?.listen(this.socket, resolve))
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  emit(type: string, data: Record<string, unknown>): void {
    for (const stream of this.streams)
      stream.write(`${JSON.stringify({ seq: 1, bootId: 'b', type, at: 1, data })}\n`)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const payload = req.method === 'POST' ? await body(req) : undefined
    this.requests.push({ method: req.method ?? '', url, body: payload })
    if (url === '/v1/health') {
      if (this.hangHealth) return
      return sendJson(res, 200, { status: 'ok', host: this.identity })
    }
    if (url === '/v1/sessions' && req.method === 'GET') {
      if (this.failSessions) return sendJson(res, 500, { error: 'internal_error' })
      return sendJson(res, 200, { items: this.sessions })
    }
    if (url === '/v1/runs')
      return sendJson(res, 200, {
        status: 'ok',
        error: null,
        updatedAt: 1,
        items: [{ runId: 'run-1' }],
      })
    if (url === '/v1/events') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ seq: 0, bootId: 'b', type: 'hello', at: 1, data: {} })}\n`)
      this.streams.add(res)
      res.once('close', () => this.streams.delete(res))
      return
    }
    if (url === '/v1/gui/channel') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ type: 'hello', header: req.headers['x-tether-client'] })}\n`)
      this.gui = res
      return
    }
    const result = /^\/v1\/gui\/results\/(.+)$/.exec(url)
    if (result?.[1]) {
      this.guiResults.push({ id: result[1], body: payload })
      return sendJson(res, 200, { accepted: true })
    }
    if (/^\/v1\/sessions\/[0-9a-f]{8}\/chat\/stream$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ type: 'hello' })}\n`)
      return
    }
    if (/^\/v1\/sessions\/[0-9a-f]{8}\/attach$/.test(url))
      return sendJson(res, 200, { generation: 'g', argv: ['/usr/bin/tmux'], env: {} })
    if (url === '/v1/sessions' && req.method === 'POST') {
      const created = session('cccc0003')
      this.sessions.push(created)
      return sendJson(res, 201, created)
    }
    if (url === '/v1/roots/root-a' && req.method === 'GET') {
      // Chunked, without a length, as root-control answered before.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.write('{"requestId":"root-a",')
      res.end('"status":"running"}')
      return
    }
    if (url.startsWith('/v1/roots?') && req.method === 'GET')
      return sendJson(res, 200, { owner: 'aico', roots: this.roots })
    if (url === '/v1/roots' && req.method === 'POST')
      return sendJson(res, 201, { requestId: 'req-1', widgetId: 'dddd0004' })
    const one = /^\/v1\/sessions\/([0-9a-f]{8})$/.exec(url)
    if (one) {
      const found = this.sessions.find((item) => item.id === one[1])
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'not_found' })
    }
    sendJson(res, 404, { error: 'not_found' })
  }
}

describe('hub', () => {
  let dir: string
  let peer: FakePeer
  let hub: Hub
  let front: Server
  let frontSocket: string
  let events: { type: string; data: Record<string, unknown> }[]
  let settings: Map<string, string>
  let guiSend: ReturnType<typeof vi.fn<(command: unknown) => Promise<GuiOutcome>>>
  const local = new Set<string>(['eeee0005'])

  function makeHub(overrides: Partial<HubDeps> = {}): Hub {
    return new Hub({
      env: { XDG_RUNTIME_DIR: dir, TETHER_HOSTS_FILE: join(dir, 'hosts.json') },
      uid: 1000,
      publish: (type, data) => events.push({ type, data }),
      gui: { send: guiSend },
      settings: {
        get: (key) => settings.get(key) ?? null,
        put: (key, value) => settings.set(key, value),
      },
      isLocalSession: (id) => local.has(id),
      isLocalRoot: () => false,
      isLocalRun: () => false,
      leadName: (id) => (id === 'eeee0005' ? 'Aico — Remote hosts' : null),
      claimLocal: (id) =>
        local.has(id) ? { coordinatorId: id, coordinatorColor: '#6fa8ff' } : null,
      log: () => {},
      random: () => 0,
      gate: { kick: () => {}, linkGraceMs: 200 },
      ...overrides,
    })
  }

  async function call(method: string, path: string, payload?: unknown) {
    return peerRequest(frontSocket, method, path, payload, 5_000)
  }

  const state = () => hub.hosts()[0]?.state

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tether-hub-'))
    events = []
    settings = new Map()
    guiSend = vi.fn(async (): Promise<GuiOutcome> => ({ status: 'applied' }))
    writeFileSync(
      join(dir, 'hosts.json'),
      JSON.stringify([
        { name: 'vm', ssh: 'vm', socket: '/run/user/1000/tether/default/control.sock' },
      ]),
    )
    const peerDirectory = join(dir, 'tether', 'peers', 'vm')
    mkdirSync(peerDirectory, { recursive: true })
    peer = new FakePeer(join(peerDirectory, 'control.sock'))
    peer.sessions = [
      session('aaaa0001', { rootRequestId: 'root-a', wakes: [{ id: 'wake-1' }] }),
      session('bbbb0002', {
        badge: { kind: 'child', text: '↳ Coordinator' },
        coordinatorId: 'eeee0005',
      }),
    ]
    await peer.start()
    hub = makeHub()
    frontSocket = join(dir, 'front.sock')
    front = createServer((req, res) => {
      if (hub.forward(req, res)) return
      void (async () => {
        try {
          if (req.url === '/v1/sessions' && req.method === 'POST')
            return await hub.create(res, '/v1/sessions', await readJsonObject(req))
          if (req.url === '/v1/roots' && req.method === 'POST')
            return await hub.create(res, '/v1/roots', await readJsonObject(req))
          sendJson(res, 404, { error: 'not_found', local: true })
        } catch (error) {
          if (error instanceof HttpError) sendError(res, error)
          else throw error
        }
      })()
    })
    await new Promise<void>((resolve) => front.listen(frontSocket, resolve))
    hub.start()
    await vi.waitFor(() => expect(state()).toBe('connected'))
  })

  afterEach(async () => {
    hub.close()
    await peer.stop()
    await new Promise<void>((resolve) => {
      front.close(() => resolve())
      front.closeAllConnections()
    })
    rmSync(dir, { recursive: true, force: true })
  })

  it('merges the peer sessions tagged with their host, and names a local coordinator', async () => {
    const items = await hub.sessions()
    expect(items.map((item) => [item.id, item.host, item.peer])).toEqual([
      ['aaaa0001', 'vm', undefined],
      ['bbbb0002', 'vm', undefined],
    ])
    expect(items[1]?.badge).toEqual({ kind: 'child', text: '↳ Aico — Remote hosts' })
    expect(events.map((event) => event.type)).toEqual([
      'peer.state',
      'session.updated',
      'session.updated',
      'peer.resync',
    ])
    expect(hub.hosts()[0]).toMatchObject({
      name: 'vm',
      ssh: 'vm',
      control: join(dir, 'tether', 'peers', 'vm', 'ssh.ctl'),
      state: 'connected',
      sessions: 2,
      error: null,
    })
  })

  it('lets the local copy of a duplicate id win', async () => {
    peer.sessions.push(session('eeee0005'))
    expect((await hub.sessions()).map((item) => item.id)).toEqual(['aaaa0001', 'bbbb0002'])
  })

  it('relays peer events with host and keeps the cache current', async () => {
    events = []
    peer.emit('session.updated', { id: 'aaaa0001', session: session('aaaa0001', { name: 'x' }) })
    peer.emit('session.ended', { id: 'bbbb0002' })
    peer.emit('gui.connected', {})
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[0]).toMatchObject({
      type: 'session.updated',
      data: { id: 'aaaa0001', host: 'vm', session: { id: 'aaaa0001', host: 'vm', name: 'x' } },
    })
    expect(events[1]).toEqual({ type: 'session.ended', data: { id: 'bbbb0002', host: 'vm' } })
    peer.failSessions = true
    expect((await hub.sessions()).map((item) => item.id)).toEqual(['aaaa0001'])
  })

  it('keeps its hosts through a hosts.json it cannot read, and drops one only when a clean file omits it', async () => {
    const file = join(dir, 'hosts.json')
    const ids = async () => (await hub.sessions()).map((item) => item.id)
    expect(await ids()).toEqual(['aaaa0001', 'bbbb0002'])
    events = []
    // An editor's half-written save.
    writeFileSync(file, '[{"name": "vm", "ssh": ')
    hub.reload()
    // An entry this Tether cannot use yet (bad value): the running link stays.
    writeFileSync(file, JSON.stringify([{ name: 'vm', ssh: 'vm', socket: 'relative.sock' }]))
    hub.reload()
    // A newer Tether's field: ignored, the entry is unchanged.
    writeFileSync(
      file,
      JSON.stringify([
        { name: 'vm', ssh: 'vm', socket: '/run/user/1000/tether/default/control.sock', later: 1 },
      ]),
    )
    hub.reload()
    expect(state()).toBe('connected')
    expect(await ids()).toEqual(['aaaa0001', 'bbbb0002'])
    expect(events.map((event) => event.type)).not.toContain('peer.resync')
    // A clean file without the host drops it.
    writeFileSync(file, '[]')
    hub.reload()
    expect(hub.hosts()).toEqual([])
    expect(await ids()).toEqual([])
    expect(events).toContainEqual({ type: 'peer.resync', data: { host: 'vm' } })
  })

  it('keeps a down peer’s sessions as stale, never gone, and resyncs on return', async () => {
    events = []
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    const stale = await hub.sessions()
    expect(
      stale.map((item) => [item.id, item.host, (item.peer as { state: string }).state]),
    ).toEqual([
      ['aaaa0001', 'vm', 'offline'],
      ['bbbb0002', 'vm', 'offline'],
    ])
    expect(events.map((event) => event.type)).toEqual([
      'peer.state',
      'session.updated',
      'session.updated',
    ])
    expect(events.some((event) => event.type === 'session.ended')).toBe(false)
    expect((events[1]?.data.session as Item | undefined)?.peer).toMatchObject({ state: 'offline' })
    // Per-session routes answer host_unavailable, never 404.
    const attach = await call('GET', '/v1/sessions/aaaa0001/attach')
    expect(attach).toEqual({
      status: 409,
      body: expect.objectContaining({ error: 'host_unavailable', host: 'vm', state: 'offline' }),
    })
    expect((await call('POST', '/v1/sessions', { host: 'vm', tool: 'shell' })).body).toMatchObject({
      error: 'host_unavailable',
      reason: 'vm is not reachable and has no wake command',
    })
    // A restarted hub still has them.
    hub.close()
    hub = makeHub()
    hub.start()
    expect((await hub.sessions()).map((item) => item.peer)).toEqual([
      expect.objectContaining({ state: 'connecting' }),
      expect.objectContaining({ state: 'connecting' }),
    ])
    events = []
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
    expect(events.map((event) => event.type)).toContain('peer.resync')
    expect((await hub.sessions()).map((item) => item.peer)).toEqual([undefined, undefined])
  })

  it('says powered off when the host status says so, and when it was powered off here', async () => {
    hub.close()
    writeFileSync(
      join(dir, 'hosts.json'),
      JSON.stringify([
        {
          name: 'vm',
          ssh: 'vm',
          socket: '/run/user/1000/tether/default/control.sock',
          status: ['st', 'vm', 'status', '200'],
        },
      ]),
    )
    let power = 'running'
    const run = vi.fn(async () => ({ code: 0, output: `VM 200 (vm): ${power} | CPU: 0%` }))
    hub = makeHub({ gate: { kick: () => {}, linkGraceMs: 200, run } })
    hub.start()
    await vi.waitFor(() => expect(state()).toBe('connected'))
    // Up: the status command is never asked.
    expect(run).not.toHaveBeenCalled()
    power = 'stopped'
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('powered_off'))
    expect(run).toHaveBeenCalledWith(['st', 'vm', 'status', '200'], expect.any(Number))
    // The raw link error stays as detail; the state is the headline.
    expect(hub.hosts()[0]?.error).toBeTruthy()
    expect((await hub.sessions())[0]?.peer).toMatchObject({ state: 'powered_off' })
    expect((await call('GET', '/v1/sessions/aaaa0001/attach')).body).toMatchObject({
      state: 'powered_off',
      reason: 'vm is powered off',
    })
    expect(hub.mergeRuns({ status: 'ok', error: null, updatedAt: 2, items: [] }).error).toBe(
      'vm is powered off',
    )
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })

    // Powered off from the Hosts panel: known without asking.
    run.mockClear()
    hub.markPoweredOff('vm')
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('powered_off'))
    expect(run).not.toHaveBeenCalled()
  })

  it('asks the link to retry at once when a down host says it is up (started outside Aico)', async () => {
    hub.close()
    writeFileSync(
      join(dir, 'hosts.json'),
      JSON.stringify([
        {
          name: 'vm',
          ssh: 'vm',
          socket: '/run/user/1000/tether/default/control.sock',
          status: ['st', 'vm', 'status', '200'],
        },
      ]),
    )
    const run = vi.fn(async () => ({ code: 0, output: 'VM 200 (vm): running | CPU: 0%' }))
    const kick = vi.fn()
    hub = makeHub({ gate: { kick, linkGraceMs: 200, run } })
    hub.start()
    await vi.waitFor(() => expect(state()).toBe('connected'))
    expect(kick).not.toHaveBeenCalled()
    // The link drops while the VM runs (st vm start after an idle power off,
    // or its Tether restarted): the hub kicks the link instead of leaving it in backoff.
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    await vi.waitFor(() => expect(kick).toHaveBeenCalledWith('vm'))
    // Once per change: further retries reuse the answer and do not kick again.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(kick).toHaveBeenCalledTimes(1)
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })

    // Just powered off from the Hosts panel: a status that still says running
    // while the VM shuts down neither kicks nor shows it as up.
    kick.mockClear()
    run.mockClear()
    hub.markPoweredOff('vm')
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('powered_off'))
    expect(run).not.toHaveBeenCalled()
    expect(kick).not.toHaveBeenCalled()
  })

  it('goes offline soon after a host stops answering, not after three missed heartbeats', async () => {
    hub.close()
    hub = makeHub({ stall: { afterMs: 150, probeMs: 150 } })
    hub.start()
    await vi.waitFor(() => expect(state()).toBe('connected'))
    // A quiet host that answers its health stays connected.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(state()).toBe('connected')
    events = []
    peer.hangHealth = true
    await vi.waitFor(() => expect(state()).toBe('offline'), { timeout: 2_000 })
    expect(hub.hosts()[0]?.error).toContain('vm stopped answering')
    expect(events.some((event) => event.type === 'session.updated')).toBe(true)
    peer.hangHealth = false
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
  })

  it('ends sessions that vanished while the host was away (a rollback), then resyncs', async () => {
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    peer.sessions = peer.sessions.filter((item) => item.id !== 'bbbb0002')
    events = []
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
    const types = events.map((event) => event.type)
    expect(events.filter((event) => event.type === 'session.ended')).toEqual([
      { type: 'session.ended', data: { id: 'bbbb0002', host: 'vm' } },
    ])
    expect(types.indexOf('session.ended')).toBeLessThan(types.indexOf('peer.resync'))
    expect((await hub.sessions()).map((item) => item.id)).toEqual(['aaaa0001'])
  })

  it('ends a forwarded stream when the host goes away mid-stream', async () => {
    const closed = new Promise<string>((resolve, reject) => {
      const req = request(
        { socketPath: frontSocket, method: 'GET', path: '/v1/sessions/aaaa0001/chat/stream' },
        (res) => {
          res.once('data', () => void peer.stop())
          res.on('error', () => {})
          res.once('close', () => resolve('closed'))
        },
      )
      req.on('error', reject)
      req.end()
    })
    await expect(closed).resolves.toBe('closed')
  })

  it('tags a JSON answer that came without a length with its host', async () => {
    expect(await call('GET', '/v1/roots/root-a')).toEqual({
      status: 200,
      body: { requestId: 'root-a', status: 'running', host: 'vm' },
    })
  })

  it('forwards per-session routes verbatim to the owning peer', async () => {
    const attach = await call('GET', '/v1/sessions/aaaa0001/attach')
    expect(attach).toEqual({
      status: 200,
      body: {
        generation: 'g',
        argv: ['/usr/bin/tmux'],
        env: {},
        host: 'vm',
        ssh: { alias: 'vm', control: join(dir, 'tether', 'peers', 'vm', 'ssh.ctl') },
      },
    })
    expect((await call('GET', '/v1/sessions/aaaa0001')).body).toMatchObject({
      id: 'aaaa0001',
      host: 'vm',
    })
    // Roots and wakes route by the ids the peer's descriptors carry.
    expect((await call('GET', '/v1/roots/root-a')).body).toMatchObject({ host: 'vm' })
    expect((await call('DELETE', '/v1/wakes/wake-1')).body).toMatchObject({ host: 'vm' })
    // A local or unknown session stays here.
    expect((await call('GET', '/v1/sessions/eeee0005')).body).toEqual({
      error: 'not_found',
      local: true,
    })
    expect((await call('GET', '/v1/sessions/ffff0006')).body).toMatchObject({ local: true })
    expect(peer.requests.filter((r) => r.url === '/v1/sessions/ffff0006')).toEqual([])
  })

  it('creates on a host without the host field, and refuses unknown hosts', async () => {
    const created = await call('POST', '/v1/sessions', {
      host: 'vm',
      tool: 'shell',
      origin: 'aico',
    })
    expect(created).toMatchObject({ status: 201, body: { id: 'cccc0003', host: 'vm' } })
    expect(peer.requests.find((r) => r.method === 'POST')?.body).toEqual({
      tool: 'shell',
      origin: 'aico',
    })
    expect((await call('GET', '/v1/sessions/cccc0003')).body).toMatchObject({ host: 'vm' })
    expect(await call('POST', '/v1/sessions', { host: 'nope', tool: 'shell' })).toEqual({
      status: 400,
      body: { error: 'unknown_host', host: 'nope' },
    })
  })

  it('passes a local launcher’s lineage to a root on a host', async () => {
    const answer = await call('POST', '/v1/roots', {
      host: 'vm',
      requestId: 'req-1',
      launchedBy: 'eeee0005',
    })
    expect(answer).toMatchObject({ status: 201, body: { requestId: 'req-1', host: 'vm' } })
    expect(peer.requests.find((r) => r.url === '/v1/roots')?.body).toEqual({
      requestId: 'req-1',
      lineage: { coordinatorId: 'eeee0005', coordinatorColor: '#6fa8ff' },
    })
    // A launcher on the same host is the peer's own to resolve.
    await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-2', launchedBy: 'aaaa0001' })
    expect(peer.requests.filter((r) => r.url === '/v1/roots')[1]?.body).toEqual({
      requestId: 'req-2',
      launchedBy: 'aaaa0001',
    })
    expect(hub.lineageFor('bbbb0002')).toEqual({
      coordinatorId: 'eeee0005',
      coordinatorColor: null,
    })
  })

  it('serves the cache while a failing list has its circuit open', async () => {
    peer.failSessions = true
    const before = peer.requests.length
    for (let i = 0; i < 5; i++) await hub.sessions()
    // Three reads open the circuit; the next two never reach the peer.
    expect(peer.requests.length - before).toBe(3)
    expect((await hub.sessions()).map((item) => item.id)).toEqual(['aaaa0001', 'bbbb0002'])
  })

  it('stops merging a host that answers as another machine until trusted', async () => {
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    peer.identity = { name: 'clone', machineId: 'bbbb' }
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('identity_changed'), { timeout: 8_000 })
    expect(hub.hosts()[0]?.error).toContain('now answers as clone')
    expect((await call('GET', '/v1/sessions/aaaa0001')).status).toBe(409)
    hub.trust('vm')
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
    expect(JSON.parse(settings.get('peer_identities') ?? '{}')).toEqual({
      vm: { hostname: 'clone', machineId: 'bbbb' },
    })
  })

  it('bridges the peer GUI channel into this one', async () => {
    await vi.waitFor(() => expect(peer.gui).not.toBeNull())
    peer.gui?.write(
      `${JSON.stringify({ type: 'command', commandId: 'c1', kind: 'show', sessionId: 'aaaa0001', generation: 'g' })}\n`,
    )
    await vi.waitFor(() => expect(peer.guiResults).toHaveLength(1))
    expect(guiSend).toHaveBeenCalledWith({ kind: 'show', sessionId: 'aaaa0001', generation: 'g' })
    expect(peer.guiResults[0]).toEqual({ id: 'c1', body: { applied: true } })
    guiSend.mockResolvedValueOnce({ status: 'unavailable' })
    peer.gui?.write(`${JSON.stringify({ type: 'command', commandId: 'c2', kind: 'layout' })}\n`)
    await vi.waitFor(() => expect(peer.guiResults).toHaveLength(2))
    expect(peer.guiResults[1]?.body).toEqual({ applied: false, error: 'gui_unavailable' })
  })

  it('merges runs and routes a run to its host', async () => {
    const merged = hub.mergeRuns({ status: 'ok', error: null, updatedAt: 2, items: [] })
    expect(merged.items).toEqual([{ runId: 'run-1', host: 'vm' }])
    expect((await call('POST', '/v1/runs/run-1/cancel')).body).toMatchObject({ host: 'vm' })
  })

  describe('wake and readiness gate', () => {
    let runs: string[][]
    let health: Record<string, number>
    /** Moves the gate's clock past its bounds without waiting them out. */
    let skew = 0

    function gatedHub(entry: Record<string, unknown>): Hub {
      writeFileSync(
        join(dir, 'hosts.json'),
        JSON.stringify([
          { name: 'vm', ssh: 'vm', socket: '/run/user/1000/tether/default/control.sock', ...entry },
        ]),
      )
      return makeHub({
        gate: {
          run: async (argv) => {
            runs.push(argv)
            if (argv[0] === 'wake') {
              await peer.start()
              return { code: 0, output: '' }
            }
            if (argv[0] === 'wake-fails') return { code: 1, output: 'ERROR VM 200 is locked' }
            const url = argv[argv.length - 1] ?? ''
            const code = health[url] ?? 0
            return { code, output: code ? 'curl: (7) Failed to connect' : '' }
          },
          kick: () => {},
          now: () => Date.now() + skew,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
          linkGraceMs: 300,
        },
      })
    }

    beforeEach(() => {
      runs = []
      health = {}
      skew = 0
    })

    async function restart(entry: Record<string, unknown>): Promise<void> {
      hub.close()
      hub = gatedHub(entry)
      hub.start()
      await vi.waitFor(() => expect(state()).toBe('connected'))
    }

    it('wakes a powered-off host once for concurrent creates, then creates there', async () => {
      await restart({ wake: ['wake'], health: ['http://127.0.0.1:8003/health'] })
      await peer.stop()
      await vi.waitFor(() => expect(state()).toBe('offline'))
      events = []
      const [first, second] = await Promise.all([
        call('POST', '/v1/sessions', { host: 'vm', tool: 'shell', origin: 'aico' }),
        call('POST', '/v1/roots', { host: 'vm', requestId: 'req-9' }),
      ])
      expect(first).toMatchObject({ status: 201, body: { id: 'cccc0003', host: 'vm' } })
      expect(second).toMatchObject({ status: 201, body: { requestId: 'req-1', host: 'vm' } })
      expect(runs.filter((argv) => argv[0] === 'wake')).toHaveLength(1)
      // Health ran on the host through the link's ControlMaster.
      const check = runs.find((argv) => argv.includes('curl'))
      expect(check?.slice(0, 11)).toEqual([
        '/usr/bin/ssh',
        '-F',
        '/dev/null',
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ProxyCommand=false',
        '-S',
        join(dir, 'tether', 'peers', 'vm', 'ssh.ctl'),
        'vm',
      ])
      const steps = events
        .filter((event) => event.type === 'peer.state')
        .map((event) => (event.data.wake as { step?: string } | null)?.step ?? null)
      expect(steps).toEqual(
        expect.arrayContaining(['powering_on', 'connecting', 'checking_services']),
      )
      expect(steps[steps.length - 1]).toBeNull()
      expect(hub.hosts()[0]?.wake).toBeNull()
    })

    it('answers host_unavailable with the real reason when a service does not answer', async () => {
      await restart({ health: ['http://127.0.0.1:8003/health'] })
      health['http://127.0.0.1:8003/health'] = 7
      const pending = call('POST', '/v1/sessions', { host: 'vm', tool: 'shell', origin: 'aico' })
      await vi.waitFor(() => expect(runs.length).toBeGreaterThan(0))
      skew = 60_000
      const answer = await pending
      expect(answer).toEqual({
        status: 409,
        body: {
          error: 'host_unavailable',
          host: 'vm',
          state: 'connected',
          reason:
            'vm is up but http://127.0.0.1:8003/health does not answer there (curl: (7) Failed to connect)',
        },
      })
      expect(hub.hosts()[0]?.wake).toMatchObject({ state: 'failed', step: 'checking_services' })
      expect(peer.requests.some((r) => r.method === 'POST')).toBe(false)
    })

    it('names the wake failure when the host never comes up', async () => {
      await restart({ wake: ['wake-fails'], wakeTimeoutSec: 10 })
      await peer.stop()
      await vi.waitFor(() => expect(state()).toBe('offline'))
      const pending = call('POST', '/v1/roots', { host: 'vm', requestId: 'req-3' })
      await vi.waitFor(() => expect(runs.length).toBe(1))
      skew = 11_000
      const answer = await pending
      expect(answer.status).toBe(409)
      expect(answer.body).toMatchObject({
        error: 'host_unavailable',
        reason: 'vm did not come up within 10 s (wake: ERROR VM 200 is locked)',
      })
    })

    it('gives a host without a wake command a short grace, then refuses', async () => {
      await restart({})
      await peer.stop()
      await vi.waitFor(() => expect(state()).toBe('offline'))
      const answer = await call('POST', '/v1/sessions', { host: 'vm', tool: 'shell' })
      expect(answer.body).toMatchObject({
        error: 'host_unavailable',
        reason: 'vm is not reachable and has no wake command',
      })
    })
  })

  it('lists the peer roots tagged with host, and keeps them while it is down', async () => {
    peer.roots = [{ requestId: 'root-z', hostIdentity: 'aaaa0001', status: 'running' }]
    expect(await hub.roots('ended=0')).toEqual([
      { requestId: 'root-z', hostIdentity: 'aaaa0001', status: 'running', host: 'vm' },
    ])
    expect(peer.requests.some((r) => r.url === '/v1/roots?ended=0')).toBe(true)
    expect((await call('GET', '/v1/roots/root-z')).body).toMatchObject({ host: 'vm' })
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    expect(await hub.roots('ended=0')).toEqual([
      expect.objectContaining({
        requestId: 'root-z',
        peer: expect.objectContaining({ state: 'offline' }),
      }),
    ])
  })
})
