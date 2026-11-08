import { execArgv } from '../exec'

const FLEET_BIN = execArgv('', [])[0] as string

import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, request, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { peerRequest } from '../peer-http'
import type { Hub, HubDeps } from './hub'
import { FakePeer, frontServer, type Item, makeTestHub, session, TEST_PORTS } from './testing'
import { NOTHING_TO_SEND, UPDATE_INSTALLING, type UpdateTarget } from './update'

const API_VERSION = TEST_PORTS.apiVersion

describe('hub', () => {
  let dir: string
  let peer: FakePeer
  let hub: Hub
  let front: Server
  let frontSocket: string
  let events: { type: string; data: Record<string, unknown> }[]
  let settings: Map<string, string>
  const local = new Set<string>(['eeee0005'])
  const localRoots = new Map<string, string>()

  function makeHub(overrides: Partial<HubDeps> = {}): Hub {
    return makeTestHub(
      {
        dir,
        get events() {
          return events
        },
        get settings() {
          return settings
        },
        local,
        localRoots,
      },
      overrides,
    )
  }

  it('catches a reload fault and retries without losing the loaded peers', () => {
    const fault = vi.fn()
    const enabled = vi.fn(() => ['vm'])
    const other = makeHub({ fleetPeers: enabled, fault })
    try {
      other.start()
      enabled.mockImplementationOnce(() => {
        throw new Error('broken fleet configuration')
      })
      writeFileSync(
        join(dir, 'hosts.json'),
        JSON.stringify([{ name: 'vm', ssh: 'vm', socket: '/tmp/new-control.sock' }]),
      )
      expect(() => other.reload()).not.toThrow()
      expect(fault).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'broken fleet configuration' }),
      )
      expect(other.hosts()).toHaveLength(1)
      other.reload()
      expect(other.hosts()).toHaveLength(1)
    } finally {
      other.close()
    }
  })

  async function call(method: string, path: string, payload?: unknown) {
    return peerRequest(frontSocket, method, path, payload, 5_000)
  }

  const state = () => hub.hosts()[0]?.state

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tether-hub-'))
    events = []
    settings = new Map()
    localRoots.clear()
    writeFileSync(
      join(dir, 'hosts.json'),
      JSON.stringify([
        { name: 'vm', ssh: 'vm', socket: '/run/user/1000/tether/default/control.sock' },
      ]),
    )
    const peerDirectory = join(dir, 'aico', 'fleet', 'vm')
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
    front = frontServer(
      () => hub,
      () => null,
    )
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
      control: join(dir, 'aico', 'fleet', 'vm', 'exec.sock'),
      state: 'connected',
      sessions: 2,
      error: null,
    })
  })

  it('tells the idle power-off what runs on a host, from its sessions and wakes', async () => {
    expect(hub.idleFacts('nobody')).toBeNull()
    expect(hub.idleFacts('vm')).toMatchObject({ live: true, sessions: 2, wakes: 1, busy: false })
    peer.emit('session.updated', {
      session: { ...peer.sessions[0], status: 'ended', wakes: [] },
    })
    peer.emit('session.updated', { session: { ...peer.sessions[1], status: 'ended' } })
    await vi.waitFor(() =>
      expect(hub.idleFacts('vm')).toMatchObject({ sessions: 0, wakes: 0, busy: false }),
    )
  })

  describe('asks and shares', () => {
    const ask = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      session: 'aaaa0001',
      requester: null,
      question: 'Go?',
      options: [],
      blocking: true,
      state: 'open',
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    })
    const share = (id: string, createdAt: string) => ({
      id,
      session: null,
      title: null,
      createdAt,
      kind: 'url',
      url: 'https://example.com',
    })

    async function relinked() {
      // A fresh link-up reads the peer's asks and shares whole.
      peer.asks = [ask('aaaaaaaaaaaa')]
      peer.shares = [share('bbbbbbbbbbbb', '2026-11-02T10:00:00.000Z')]
      await peer.stop()
      await peer.start()
      hub.reload()
      for (const stream of peer.streams) stream.end()
      await vi.waitFor(
        () => {
          expect(state()).toBe('connected')
          expect(hub.mergeAsks([], { states: [] }).length).toBeGreaterThan(0)
        },
        {
          timeout: 5_000,
        },
      )
    }

    it("merges the peer's asks tagged with their host and marks them when the link is down", async () => {
      let releaseShares = () => {}
      peer.sharesReady = new Promise<void>((resolve) => {
        releaseShares = resolve
      })
      const linked = relinked()
      await vi.waitFor(() => expect(hub.mergeAsks([], { states: [] }).length).toBeGreaterThan(0), {
        timeout: 5000,
      })
      // Keep metadata incomplete across a readiness poll, as the full CI run did.
      setTimeout(releaseShares, 150)
      await linked
      const local = [{ id: 'cccccccccccc', state: 'open' }]
      const merged = hub.mergeAsks(local, { states: ['open'] })
      expect(merged.map((item) => [item.id, item.host, item.peer])).toEqual([
        ['cccccccccccc', undefined, undefined],
        ['aaaaaaaaaaaa', 'vm', undefined],
      ])
      expect(hub.mergeAsks([], { states: ['done'] })).toEqual([])
      expect(hub.mergeAsks([], { states: [], session: 'zzzzzzzz' })).toEqual([])
      await peer.stop()
      await vi.waitFor(() => expect(state()).not.toBe('connected'), { timeout: 5_000 })
      // Cached, never live: the mark says why and when.
      const away = hub.mergeAsks([], { states: [] })
      expect(away).toHaveLength(1)
      expect(away[0]).toMatchObject({ id: 'aaaaaaaaaaaa', host: 'vm', peer: { state: 'offline' } })
    })

    it('relays asks.changed and show.requested with host, and keeps the cache current', async () => {
      events = []
      peer.emit('asks.changed', { ask: ask('dddddddddddd'), created: true })
      peer.emit('show.requested', share('eeeeeeeeeeee', '2026-11-02T11:00:00.000Z'))
      await vi.waitFor(() => expect(events).toHaveLength(2))
      expect(events[0]).toMatchObject({
        type: 'asks.changed',
        data: { created: true, host: 'vm', ask: { id: 'dddddddddddd', host: 'vm' } },
      })
      expect(events[1]).toMatchObject({
        type: 'show.requested',
        data: { id: 'eeeeeeeeeeee', host: 'vm' },
      })
      // A change replaces the cached copy.
      peer.emit('asks.changed', { ask: ask('dddddddddddd', { state: 'answered' }), created: false })
      await vi.waitFor(() => expect(events).toHaveLength(3))
      const cached = hub.mergeAsks([], { states: [] }).filter((item) => item.id === 'dddddddddddd')
      expect(cached).toHaveLength(1)
      expect(cached[0]?.state).toBe('answered')
      expect(hub.mergeShares([]).map((item) => item.id)).toContain('eeeeeeeeeeee')
    })

    it("does not echo this host's own asks back, nor what the peer relayed from its own peers", async () => {
      events = []
      peer.emit('asks.changed', { ask: ask('cccccccccccc'), created: true })
      peer.emit('asks.changed', {
        ask: ask('ffffffffffff', { host: 'other' }),
        created: true,
        host: 'other',
      })
      peer.emit('show.requested', {
        ...share('999999999999', '2026-11-02T11:00:00.000Z'),
        host: 'other',
      })
      peer.emit('asks.changed', { ask: ask('dddddddddddd'), created: true })
      await vi.waitFor(() => expect(events).toHaveLength(1))
      expect(events[0]?.data.ask).toMatchObject({ id: 'dddddddddddd' })
      expect(hub.mergeAsks([], { states: [] }).map((item) => item.id)).toEqual(['dddddddddddd'])
    })

    it('a share that replaces another drops it from the cache', async () => {
      peer.emit('show.requested', share('aaaaaaaaaaaa', '2026-11-02T11:00:00.000Z'))
      peer.emit('show.requested', {
        ...share('bbbbbbbbbbbb', '2026-11-02T12:00:00.000Z'),
        replaces: 'aaaaaaaaaaaa',
      })
      await vi.waitFor(() =>
        expect(hub.mergeShares([]).map((item) => item.id)).toEqual(['bbbbbbbbbbbb']),
      )
    })

    it('merges shares oldest first', async () => {
      await relinked()
      const mine = [
        share('000000000001', '2026-11-02T09:00:00.000Z'),
        share('000000000002', '2026-11-02T12:00:00.000Z'),
      ]
      // The host's shares are read right after the link comes up.
      await vi.waitFor(() => expect(hub.mergeShares(mine)).toHaveLength(3))
      const merged = hub.mergeShares(mine)
      expect(merged.map((item) => item.id)).toEqual([
        '000000000001',
        'bbbbbbbbbbbb',
        '000000000002',
      ])
    })

    it("sends an answer to the owning host's Tether, and refuses it while that host is down", async () => {
      await relinked()
      const answered = await call('POST', '/v1/asks/aaaaaaaaaaaa/answer', { text: 'Yes' })
      expect(answered.status).toBe(200)
      expect(answered.body).toMatchObject({ id: 'aaaaaaaaaaaa', state: 'answered', host: 'vm' })
      expect(peer.requests.at(-1)).toEqual({
        method: 'POST',
        url: '/v1/asks/aaaaaaaaaaaa/answer',
        body: { text: 'Yes' },
      })
      // This host's own ask is the local router's, not the peer's.
      const own = await call('POST', '/v1/asks/cccccccccccc/answer', { text: 'Yes' })
      expect(own.status).toBe(404)
      expect(own.body).toMatchObject({ local: true })
      await peer.stop()
      await vi.waitFor(() => expect(state()).not.toBe('connected'), { timeout: 5_000 })
      const down = await call('POST', '/v1/asks/aaaaaaaaaaaa/done')
      expect(down.status).toBe(409)
      expect(down.body).toMatchObject({ error: 'host_unavailable', host: 'vm' })
    })

    it('copes with a Tether that has neither route', async () => {
      peer.asks = null
      peer.shares = null
      await peer.stop()
      await peer.start()
      for (const stream of peer.streams) stream.end()
      await vi.waitFor(() => expect(state()).toBe('connected'))
      expect(hub.mergeAsks([], { states: [] })).toEqual([])
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
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[0]).toMatchObject({
      type: 'session.updated',
      data: { id: 'aaaa0001', host: 'vm', session: { id: 'aaaa0001', host: 'vm', name: 'x' } },
    })
    expect(events[1]).toEqual({ type: 'session.ended', data: { id: 'bbbb0002', host: 'vm' } })
    peer.failSessions = true
    expect((await hub.sessions()).map((item) => item.id)).toEqual(['aaaa0001'])
  })

  it('never relays back what the peer relayed itself (two hosts linked both ways)', async () => {
    events = []
    // Echoes: the peer's copies of events it took from its own peers carry `host`.
    peer.emit('wakes.changed', { sessionId: 'cccc0003', host: 'here' })
    peer.emit('tools.changed', { change: 'updated', host: 'here' })
    peer.emit('session.updated', {
      id: 'dddd0004',
      host: 'here',
      session: session('dddd0004', { host: 'here' }),
    })
    peer.emit('wakes.changed', { sessionId: 'aaaa0001' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({
      type: 'wakes.changed',
      data: { sessionId: 'aaaa0001', host: 'vm' },
    })
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

  it('retires only a host that a hosts.json there and parsed leaves out (placement releases its reservations)', () => {
    const file = join(dir, 'hosts.json')
    hub.close()
    // A restart with a file it cannot parse: nothing is retired.
    writeFileSync(file, '[{"name": "vm", "ssh": ')
    hub = makeHub()
    hub.reload()
    expect(hub.retired('vm')).toBe(false)
    expect(hub.retired('neri-box-1')).toBe(false)
    // No file at all (briefly gone, or the hub's first look): nothing either.
    rmSync(file)
    hub.reload()
    expect(hub.retired('neri-box-1')).toBe(false)
    // An entry it cannot use yet is held, not retired; a name not listed is.
    writeFileSync(file, JSON.stringify([{ name: 'vm', ssh: 'vm', socket: 'relative.sock' }]))
    hub.reload()
    expect(hub.retired('vm')).toBe(false)
    expect(hub.retired('neri-box-1')).toBe(true)
    // The file then goes for a moment: what it last said stands.
    rmSync(file)
    hub.reload()
    expect(hub.retired('vm')).toBe(false)
    expect(hub.retired('neri-box-1')).toBe(true)
  })

  it.each(['/v1/tools', '/v1/projects'])(
    'recognizes an atomically appended host on the first %s query before periodic reload',
    async (path) => {
      hub.close()
      // Hold periodic reloads still while HTTP and peer connections run normally.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        hub = makeHub()
        hub.start()
        const reload = vi.spyOn(hub, 'reload')
        const file = join(dir, 'hosts.json')
        writeFileSync(
          `${file}.new`,
          JSON.stringify([
            { name: 'vm', ssh: 'vm', socket: '/run/user/1000/tether/default/control.sock' },
            { name: 'fresh', ssh: 'fresh', socket: '/run/user/1000/tether/default/control.sock' },
          ]),
        )
        renameSync(`${file}.new`, file)
        expect(hub.hostNames()).toEqual(['vm'])

        // The new host has no link yet: it is known but must pass the usual connection check.
        expect(await call('GET', `${path}?host=fresh`)).toMatchObject({
          status: 409,
          body: { error: 'host_unavailable', host: 'fresh' },
        })
        expect(reload).toHaveBeenCalledTimes(1)
        expect(hub.hostNames()).toEqual(['vm', 'fresh'])

        expect(await call('GET', `${path}?host=missing`)).toEqual({
          status: 400,
          body: { error: 'unknown_host', host: 'missing' },
        })
        // Even a miss-triggered refresh keeps peers when an editor's save is incomplete.
        writeFileSync(file, '[{"name":')
        expect((await call('GET', `${path}?host=missing`)).body).toEqual({
          error: 'unknown_host',
          host: 'missing',
        })
        expect(hub.hostNames()).toEqual(['vm', 'fresh'])
      } finally {
        hub.close()
        vi.useRealTimers()
      }
    },
  )

  it('uses a cached named host without refreshing the catalog', async () => {
    const reload = vi.spyOn(hub, 'reload')
    expect((await call('GET', '/v1/tools?host=vm')).body).toMatchObject({ host: 'vm' })
    expect(reload).not.toHaveBeenCalled()
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

  it('keeps a quiet event stream until the underlying link closes', async () => {
    peer.hangHealth = true
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(state()).toBe('connected')
    peer.hangHealth = false
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
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
        fleet: { alias: 'vm', control: join(dir, 'aico', 'fleet', 'vm', 'exec.sock') },
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

  it('tells lane reports who asked for a forwarded End, and takes it back when nothing ended', async () => {
    const marks: [string, string, string | null][] = []
    hub.close()
    hub = makeHub({ endedBy: (host, id, by) => marks.push([host, id, by]) })
    hub.start()
    await vi.waitFor(() => expect(state()).toBe('connected'))
    const end = (id: string, by?: string) =>
      new Promise<number>((resolve, reject) => {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (by) headers['Tether-Ended-By'] = by
        const req = request(
          { socketPath: frontSocket, method: 'POST', path: `/v1/sessions/${id}/end`, headers },
          (res) => {
            res.resume()
            res.once('end', () => resolve(res.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        req.end('{}')
      })
    expect(await end('aaaa0001', 'cccc0003')).toBe(200)
    expect(marks).toEqual([['vm', 'aaaa0001', 'cccc0003']])
    // The asker stays out of the forwarded body.
    expect(peer.requests.at(-1)).toMatchObject({ url: '/v1/sessions/aaaa0001/end', body: {} })
    // No header, a malformed one, or the session itself: no mark.
    await end('aaaa0001')
    await end('aaaa0001', 'nope')
    await end('aaaa0001', 'aaaa0001')
    expect(marks).toHaveLength(1)
    peer.refuseEnd = true
    expect(await end('bbbb0002', 'cccc0003')).toBe(409)
    expect(marks.slice(1)).toEqual([
      ['vm', 'bbbb0002', 'cccc0003'],
      ['vm', 'bbbb0002', null],
    ])
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
    // A root here launched by a remote lane nests under that lane.
    expect(hub.lineageFor('bbbb0002')).toEqual({
      coordinatorId: 'eeee0005',
      coordinatorColor: null,
      parentId: 'bbbb0002',
    })
  })

  it('passes the launcher as parent only to a host that takes it', async () => {
    // The older peer above got no parentId; one at API 9 does.
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    peer.apiVersion = 9
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
    await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-3', launchedBy: 'eeee0005' })
    expect(peer.requests.filter((r) => r.url === '/v1/roots').at(-1)?.body).toEqual({
      requestId: 'req-3',
      lineage: { coordinatorId: 'eeee0005', coordinatorColor: '#6fa8ff', parentId: 'eeee0005' },
    })
  })

  it('forwards a root entry only to a host whose Tether runs entries', async () => {
    const entry = { name: 'neri-hunt', arg: 'case-1' }
    // A peer below API 15 (this fixture's reports none): refused here, nothing sent.
    const before = peer.requests.filter((r) => r.url === '/v1/roots').length
    expect(await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-e1', entry })).toEqual({
      status: 400,
      body: {
        error: 'entry_unsupported',
        host: 'vm',
        reason: expect.stringContaining('vm runs a Tether without session entries'),
      },
    })
    expect(peer.requests.filter((r) => r.url === '/v1/roots')).toHaveLength(before)
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    // API 18 (what a VM installs before Codex entries): Claude entries only.
    peer.apiVersion = 18
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
    await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-e2', entry })
    expect(peer.requests.filter((r) => r.url === '/v1/roots').at(-1)?.body).toEqual({
      requestId: 'req-e2',
      entry,
    })
    // A Codex root through an entry needs API 19: refused here, nothing sent, never run here.
    const sent = peer.requests.filter((r) => r.url === '/v1/roots').length
    expect(
      await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-e3', tool: 'codex', entry }),
    ).toEqual({
      status: 400,
      body: {
        error: 'entry_unsupported',
        host: 'vm',
        reason: expect.stringContaining('entries run claude-code only (API 18)'),
      },
    })
    expect(peer.requests.filter((r) => r.url === '/v1/roots')).toHaveLength(sent)
    // A Pi root through an entry needs API 20: refused at 18 and 19, nothing sent.
    const pi = { host: 'vm', tool: 'pi', model: 'opencode-go/glm-5.3-flash', entry }
    expect(await call('POST', '/v1/roots', { ...pi, requestId: 'req-e4' })).toEqual({
      status: 400,
      body: {
        error: 'entry_unsupported',
        host: 'vm',
        reason: expect.stringContaining('entries run claude-code only (API 18)'),
      },
    })
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    peer.apiVersion = 19
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
    expect(await call('POST', '/v1/roots', { ...pi, requestId: 'req-e5' })).toEqual({
      status: 400,
      body: {
        error: 'entry_unsupported',
        host: 'vm',
        reason: expect.stringContaining('entries run claude-code and codex only (API 19)'),
      },
    })
    expect(peer.requests.filter((r) => r.url === '/v1/roots')).toHaveLength(sent)
    // At 20 it goes as sent (the host's own entries.json decides the name).
    await peer.stop()
    await vi.waitFor(() => expect(state()).toBe('offline'))
    peer.apiVersion = 20
    await peer.start()
    await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
    await call('POST', '/v1/roots', { ...pi, requestId: 'req-e6' })
    expect(peer.requests.filter((r) => r.url === '/v1/roots').at(-1)?.body).toEqual({
      requestId: 'req-e6',
      tool: 'pi',
      model: 'opencode-go/glm-5.3-flash',
      entry,
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

  it('logs a failing list once per circuit window, not once per concurrent caller', async () => {
    hub.close()
    const lines: string[] = []
    hub = makeHub({ log: (line) => lines.push(line) })
    hub.start()
    await vi.waitFor(() => expect(state()).toBe('connected'))
    peer.failSessions = true
    await Promise.all(Array.from({ length: 71 }, () => hub.sessions()))
    expect(lines.filter((line) => line.includes('session list failed'))).toHaveLength(1)
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

  describe('a host on this API but another build of the release', () => {
    const ours = { hash: 'b'.repeat(64), issuedAt: 2000 }
    const older = { hash: 'a'.repeat(64), issuedAt: 1000 }
    const update = () => hub.hosts()[0]?.update as Record<string, unknown> | null | undefined
    let rows: { id: string; state: string; meaning: string }[]

    async function startHub(overrides: Partial<HubDeps> = {}): Promise<void> {
      hub.close()
      rows = []
      hub = makeHub({
        build: ours,
        releaseSweepMs: 100,
        status: async (row) => {
          rows.push(row)
        },
        ...overrides,
      })
      hub.start()
      await vi.waitFor(() => expect(state()).toBe('connected'))
    }

    /** The host restarts on the pushed build, as the update's restart does. */
    async function restartOnOurs(): Promise<void> {
      peer.release = ours
      await peer.stop()
      await peer.start()
    }

    beforeEach(() => {
      peer.apiVersion = API_VERSION
      peer.sessions = []
    })

    it('pushes this build to an idle host and says so in Status', async () => {
      peer.release = older
      const targets: UpdateTarget[] = []
      await startHub({
        update: async (target) => {
          targets.push(target)
          await restartOnOurs()
          return { code: 0, stdout: `${UPDATE_INSTALLING}\n`, output: '' }
        },
      })
      await vi.waitFor(() => expect(update()?.state).toBe('updated'), { timeout: 8_000 })
      expect(targets).toHaveLength(1)
      expect(update()).toMatchObject({
        from: API_VERSION,
        to: API_VERSION,
        build: { from: 'aaaaaaaa', to: 'bbbbbbbb' },
      })
      expect(rows).toEqual([
        expect.objectContaining({
          id: 'tether/release-update/vm',
          state: 'ok',
          meaning: expect.stringContaining('release bbbbbbbb (was aaaaaaaa)'),
        }),
      ])
    })

    it('pushes to a host that names no release (it predates the field)', async () => {
      peer.release = undefined
      let calls = 0
      await startHub({
        update: async () => {
          calls += 1
          await restartOnOurs()
          return { code: 0, stdout: '', output: '' }
        },
      })
      await vi.waitFor(() => expect(update()?.state).toBe('updated'), { timeout: 8_000 })
      expect(calls).toBe(1)
    })

    it('a hub with nothing to send writes no Status row and shows no update', async () => {
      peer.release = older
      let calls = 0
      await startHub({
        update: async () => {
          calls += 1
          return { code: null, stdout: NOTHING_TO_SEND, output: '' }
        },
      })
      await vi.waitFor(() => expect(calls).toBeGreaterThan(0))
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(update()).toBeNull()
      expect(rows).toEqual([])
      expect(JSON.parse(settings.get('peer_update_failures') ?? '{}')).toEqual({})
    })

    it('does not push when the host already runs this build', async () => {
      peer.release = ours
      let calls = 0
      await startHub({
        update: async () => {
          calls += 1
          return { code: 0, stdout: '', output: '' }
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(calls).toBe(0)
      expect(update()).toBeNull()
      // Says so once, so an earlier failure on this host doesn't stand.
      expect(rows).toEqual([
        expect.objectContaining({ id: 'tether/release-update/vm', state: 'ok', kind: 'check' }),
      ])
    })

    it('never pushes an older or same-age build over a host that runs a newer deploy', async () => {
      let calls = 0
      const counting = async () => {
        calls += 1
        return { code: 0, stdout: '', output: '' }
      }
      peer.release = { hash: 'c'.repeat(64), issuedAt: 3000 }
      await startHub({ update: counting })
      await new Promise((resolve) => setTimeout(resolve, 400))
      peer.release = { hash: 'c'.repeat(64), issuedAt: 2000 }
      await startHub({ update: counting })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(calls).toBe(0)
      // And an API below the host's is never taken down either.
      peer.apiVersion = API_VERSION + 1
      peer.release = older
      await startHub({ update: counting })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(calls).toBe(0)
    })

    it('holds off while sessions run there, and pushes once they end', async () => {
      peer.release = older
      peer.sessions = [session('aaaa0001')]
      let calls = 0
      await startHub({
        update: async () => {
          calls += 1
          await restartOnOurs()
          return { code: 0, stdout: '', output: '' }
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(calls).toBe(0)
      expect(update()).toBeNull()
      peer.emit('session.updated', { session: { ...peer.sessions[0], status: 'ended' } })
      await vi.waitFor(() => expect(update()?.state).toBe('updated'), { timeout: 8_000 })
      expect(calls).toBe(1)
    })

    it('says why a failed push failed and does not repeat it on this hub release', async () => {
      peer.release = older
      let calls = 0
      const failing = async () => {
        calls += 1
        return { code: 1, stdout: `${UPDATE_INSTALLING}\n`, output: 'its install failed' }
      }
      await startHub({ release: 'release-a', update: failing })
      await vi.waitFor(() => expect(update()?.state).toBe('failed'))
      // An install that started and failed is a real failure, but never a service down.
      expect(rows[0]).toMatchObject({ state: 'failed', kind: 'check' })
      expect(rows[0]?.meaning).toContain('its install failed')
      await startHub({ release: 'release-a', update: failing })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(calls).toBe(1)
      await startHub({ release: 'release-b', update: failing })
      await vi.waitFor(() => expect(calls).toBe(2))
    })

    it('sends nothing when this hub has no installed release of its own', async () => {
      peer.release = older
      let calls = 0
      await startHub({
        build: null,
        update: async () => {
          calls += 1
          return { code: 0, stdout: '', output: '' }
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(calls).toBe(0)
    })
  })

  describe('a host whose Tether is on an older API', () => {
    const roots = () => peer.requests.filter((r) => r.url === '/v1/roots' && r.method === 'POST')
    const update = () => hub.hosts()[0]?.update as Record<string, unknown> | null | undefined

    /** Restart the fake host on this hub's API, as the update's restart does. */
    async function restartUpdated(): Promise<void> {
      peer.apiVersion = API_VERSION
      peer.refuseBody = false
      await peer.stop()
      await peer.start()
    }

    async function startHub(overrides: Partial<HubDeps>): Promise<void> {
      hub.close()
      peer.apiVersion = 20
      hub = makeHub(overrides)
      hub.start()
      await vi.waitFor(() => expect(state()).toBe('connected'))
    }

    it('gets this release over its link and is updated once it is back on it', async () => {
      const targets: UpdateTarget[] = []
      await startHub({
        update: async (target) => {
          targets.push(target)
          await restartUpdated()
          return { code: 0, stdout: '', output: '' }
        },
      })
      await vi.waitFor(() => expect(update()?.state).toBe('updated'), { timeout: 8_000 })
      expect(targets).toEqual([
        {
          entry: expect.objectContaining({ name: 'vm', ssh: 'vm' }),
          control: join(dir, 'aico', 'fleet', 'vm', 'exec.sock'),
          instance: 'default',
        },
      ])
      expect(hub.hosts()[0]).toMatchObject({
        state: 'connected',
        apiVersion: API_VERSION,
        update: { state: 'updated', from: 20, to: API_VERSION, error: null },
      })
      // Never a peer.state of its own: open remote terminals let go of a host on one.
      expect(events.filter((e) => e.type === 'peer.state' && 'update' in e.data)).toEqual([])
    })

    it('holds a create until the update is done, and says why an older host refuses meanwhile', async () => {
      let finish = () => {}
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const targets: UpdateTarget[] = []
      await startHub({
        update: async (target) => {
          targets.push(target)
          await finished
          await restartUpdated()
          return { code: 0, stdout: '', output: '' }
        },
      })
      await vi.waitFor(() => expect(targets).toHaveLength(1))
      peer.refuseBody = true
      // A forwarded request the old Tether does not know: a reason, never a bare invalid_body.
      expect(
        await call('POST', '/v1/sessions/aaaa0001/deliveries', { text: 'hi', reply: true }),
      ).toEqual({
        status: 400,
        body: {
          error: 'invalid_body',
          field: 'reply',
          host: 'vm',
          reason: `remote Tether on vm is API 20, needs ${API_VERSION}; updating`,
        },
      })
      const before = roots().length
      const created = call('POST', '/v1/roots', { host: 'vm', requestId: 'req-u1' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(roots()).toHaveLength(before)
      finish()
      expect(await created).toMatchObject({ status: 201, body: { requestId: 'req-1', host: 'vm' } })
      expect(roots().at(-1)?.body).toEqual({ requestId: 'req-u1' })
      expect(update()?.state).toBe('updated')
    })

    it('stays usable after a failed update, says why it refuses, and is not retried at once', async () => {
      let calls = 0
      await startHub({
        update: async () => {
          calls += 1
          // The host began installing, then rolled back: this release fails again there.
          return {
            code: 1,
            stdout: `${UPDATE_INSTALLING}\n`,
            output: 'its install failed; the previous release is back',
          }
        },
      })
      await vi.waitFor(() => expect(update()?.state).toBe('failed'))
      expect(update()).toMatchObject({
        from: 20,
        to: API_VERSION,
        error: 'its install failed; the previous release is back',
      })
      // A create it takes still goes there.
      expect((await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-u2' })).status).toBe(
        201,
      )
      peer.refuseBody = true
      expect(await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-u3' })).toEqual({
        status: 400,
        body: {
          error: 'invalid_body',
          field: 'reply',
          host: 'vm',
          reason: `remote Tether on vm is API 20, needs ${API_VERSION}; update failed: its install failed; the previous release is back`,
        },
      })
      // A link-up soon after does not restart the host's Tether again.
      await peer.stop()
      await vi.waitFor(() => expect(state()).toBe('offline'))
      await peer.start()
      await vi.waitFor(() => expect(state()).toBe('connected'), { timeout: 8_000 })
      expect(calls).toBe(1)
    })

    it('remembers a failed update across hub restarts and tries it again only on another release', async () => {
      let calls = 0
      const failing: Partial<HubDeps> = {
        release: 'release-a',
        update: async () => {
          calls += 1
          return {
            code: 1,
            stdout: `${UPDATE_INSTALLING}\n`,
            output: 'node: v20 is older than 22.13',
          }
        },
      }
      await startHub(failing)
      await vi.waitFor(() => expect(update()?.state).toBe('failed'))
      // A hub restart (every deploy) on the same release, long after: no new
      // attempt, and the failure still shows.
      await startHub({ ...failing, now: () => Date.now() + 24 * 3_600_000 })
      expect(update()).toMatchObject({ state: 'failed', error: 'node: v20 is older than 22.13' })
      peer.refuseBody = true
      expect(
        (await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-u5' })).body,
      ).toMatchObject({
        reason: `remote Tether on vm is API 20, needs ${API_VERSION}; update failed: node: v20 is older than 22.13`,
      })
      peer.refuseBody = false
      expect(calls).toBe(1)
      // Another hub release tries again, and success clears the record.
      await startHub({
        release: 'release-b',
        update: async () => {
          calls += 1
          await restartUpdated()
          return { code: 0, stdout: '', output: '' }
        },
      })
      await vi.waitFor(() => expect(update()?.state).toBe('updated'), { timeout: 8_000 })
      expect(calls).toBe(2)
      expect(JSON.parse(settings.get('peer_update_failures') ?? '{}')).toEqual({})
    })

    it('drops a remembered failure once the host is on this API some other way', async () => {
      const failing: Partial<HubDeps> = {
        release: 'release-a',
        update: async () => ({
          code: 1,
          stdout: `${UPDATE_INSTALLING}\n`,
          output: 'install failed',
        }),
      }
      await startHub(failing)
      await vi.waitFor(() => expect(update()?.state).toBe('failed'))
      // Updated by hand (the VM201 fix): the next hub start shows it as fine.
      hub.close()
      peer.apiVersion = API_VERSION
      hub = makeHub(failing)
      hub.start()
      await vi.waitFor(() => expect(state()).toBe('connected'))
      await vi.waitFor(() => expect(update()).toBeNull())
      expect(JSON.parse(settings.get('peer_update_failures') ?? '{}')).toEqual({})
    })

    it('tries a failure that installed nothing again on the next link-up, once per link-up', async () => {
      const failures = [
        // The ssh session dropped before the host began installing.
        { code: 255, stdout: '', output: 'Connection to vm closed by remote host.' },
        // Another update held the host's lock.
        { code: 75, stdout: '', output: "another update of this host's Tether is still running" },
      ]
      let calls = 0
      await startHub({
        release: 'release-a',
        update: async () => {
          const failure = failures[calls]
          calls += 1
          if (failure) return failure
          await restartUpdated()
          return { code: 0, stdout: `${UPDATE_INSTALLING}\n`, output: '' }
        },
      })
      await vi.waitFor(() => expect(update()?.state).toBe('failed'))
      expect(update()?.error).toBe(
        'Connection to vm closed by remote host.; nothing was installed, tried again on the next link-up',
      )
      expect(JSON.parse(settings.get('peer_update_failures') ?? '{}')).toEqual({})
      // No tight loop: nothing more until the link comes up again.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(calls).toBe(1)
      for (const expected of [2, 3]) {
        await peer.stop()
        await vi.waitFor(() => expect(state()).toBe('offline'))
        await peer.start()
        await vi.waitFor(() => expect(calls).toBe(expected), { timeout: 8_000 })
      }
      await vi.waitFor(() => expect(update()?.state).toBe('updated'), { timeout: 8_000 })
      expect(calls).toBe(3)
    })

    it('says when the update did not bring the host to this API', async () => {
      await startHub({
        update: async () => ({ code: 0, stdout: '', output: '' }),
        updateReconnectMs: 300,
      })
      await vi.waitFor(() => expect(update()?.state).toBe('failed'))
      expect(update()?.error).toBe('its Tether still answers API 20 after the update')
    })

    it('leaves a host on this API, or one that names none, alone', async () => {
      let calls = 0
      const counting: Partial<HubDeps> = {
        update: async () => {
          calls += 1
          return { code: 0, stdout: '', output: '' }
        },
      }
      hub.close()
      peer.apiVersion = undefined
      hub = makeHub(counting)
      hub.start()
      await vi.waitFor(() => expect(state()).toBe('connected'))
      hub.close()
      peer.apiVersion = API_VERSION
      hub = makeHub(counting)
      hub.start()
      await vi.waitFor(() => expect(state()).toBe('connected'))
      expect(calls).toBe(0)
      expect(hub.hosts()[0]).toMatchObject({ apiVersion: API_VERSION, update: null })
      // A host above this hub is never taken down to it.
      hub.close()
      peer.apiVersion = API_VERSION + 1
      hub = makeHub(counting)
      hub.start()
      await vi.waitFor(() => expect(state()).toBe('connected'))
      expect(calls).toBe(0)
      expect(hub.hosts()[0]).toMatchObject({ apiVersion: API_VERSION + 1, update: null })
      peer.refuseBody = true
      expect(await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-u6' })).toEqual({
        status: 400,
        body: { error: 'invalid_body', field: 'reply', host: 'vm' },
      })
      hub.close()
      peer.apiVersion = API_VERSION
      peer.refuseBody = false
      hub = makeHub(counting)
      hub.start()
      await vi.waitFor(() => expect(state()).toBe('connected'))
      peer.refuseBody = true
      // Not behind: the host's own answer, as before.
      expect(await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-u4' })).toEqual({
        status: 400,
        body: { error: 'invalid_body', field: 'reply', host: 'vm' },
      })
    })
  })

  describe('wake and readiness gate', () => {
    let runs: string[][]
    let health: Record<string, number>
    /** Runs before a health check answers (the host can go away meanwhile). */
    let onHealth: (() => Promise<number | null>) | null
    /** Moves the gate's clock past its bounds without waiting them out. */
    let skew = 0

    function gatedHub(entry: Record<string, unknown>, overrides: Partial<HubDeps> = {}): Hub {
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
            const hooked = onHealth ? await onHealth() : null
            const code = hooked ?? health[url] ?? 0
            return { code, output: code ? 'curl: (7) Failed to connect' : '' }
          },
          kick: () => {},
          now: () => Date.now() + skew,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
          linkGraceMs: 300,
        },
        ...overrides,
      })
    }

    beforeEach(() => {
      runs = []
      health = {}
      onHealth = null
      skew = 0
    })

    async function restart(
      entry: Record<string, unknown>,
      overrides: Partial<HubDeps> = {},
    ): Promise<void> {
      hub.close()
      hub = gatedHub(entry, overrides)
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
      expect(check?.slice(0, 5)).toEqual([
        FLEET_BIN,
        'fleet',
        'exec',
        join(dir, 'aico', 'fleet', 'vm', 'exec.sock'),
        '--',
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

    it('wakes a host that went away while its link still looked up, on the first create', async () => {
      // `st vm rollback` powers the VM off; the create arrives before the link notices.
      await restart({ wake: ['wake'], health: ['http://127.0.0.1:8003/health'] })
      let gone = false
      onHealth = async () => {
        if (gone) return null
        gone = true
        await peer.stop()
        // While a create waits on it the host shows as connecting.
        await vi.waitFor(() => expect(state()).not.toBe('connected'))
        return 255
      }
      const answer = await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-7' })
      expect(answer).toMatchObject({ status: 201, body: { host: 'vm' } })
      expect(runs.filter((argv) => argv[0] === 'wake')).toHaveLength(1)
      expect(runs.filter((argv) => argv.includes('curl'))).toHaveLength(2)
      expect(hub.hosts()[0]?.wake).toBeNull()
    })

    it('refuses when the host goes away again after it was brought up', async () => {
      await restart({ wake: ['wake'], health: ['http://127.0.0.1:8003/health'] })
      onHealth = async () => {
        await peer.stop()
        // While a create waits on it the host shows as connecting.
        await vi.waitFor(() => expect(state()).not.toBe('connected'))
        return 255
      }
      const answer = await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-8' })
      expect(answer).toMatchObject({
        status: 409,
        body: { error: 'host_unavailable', reason: 'vm went away while its services were checked' },
      })
      expect(runs.filter((argv) => argv[0] === 'wake')).toHaveLength(1)
      expect(peer.requests.some((r) => r.method === 'POST')).toBe(false)
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

    it('waits out the update a woken host starts before it checks its services', async () => {
      // Powered off on an older API: the create wakes it, its link-up starts the
      // update, and the update's restart takes the host off the link meanwhile.
      let updating = false
      let checking = () => {}
      // The restart comes once a service check is under way (or soon anyway).
      const checked = new Promise<void>((resolve) => {
        checking = resolve
        setTimeout(resolve, 500)
      })
      await restart(
        { wake: ['wake'], health: ['http://127.0.0.1:8003/health'] },
        {
          update: async () => {
            updating = true
            await checked
            await peer.stop()
            peer.apiVersion = API_VERSION
            await new Promise((resolve) => setTimeout(resolve, 300))
            await peer.start()
            updating = false
            return { code: 0, stdout: '', output: '' }
          },
        },
      )
      await peer.stop()
      await vi.waitFor(() => expect(state()).toBe('offline'))
      peer.apiVersion = 20
      // A service check made while the update restarts the host sees it gone.
      onHealth = async () => {
        if (!updating) return null
        checking()
        await vi.waitFor(() => expect(state()).not.toBe('connected'))
        return 7
      }
      const answer = await call('POST', '/v1/roots', { host: 'vm', requestId: 'req-w1' })
      expect(answer).toMatchObject({ status: 201, body: { host: 'vm' } })
      expect(runs.filter((argv) => argv[0] === 'wake')).toHaveLength(1)
      expect(hub.hosts()[0]).toMatchObject({
        apiVersion: API_VERSION,
        update: { state: 'updated' },
        wake: null,
      })
    })

    it("bounds a create's wait on an update by the host's wake time", async () => {
      let finish = () => {}
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      peer.apiVersion = 20
      await restart(
        { wakeTimeoutSec: 10 },
        {
          update: async () => {
            await finished
            return { code: 1, stdout: '', output: 'cancelled' }
          },
        },
      )
      await vi.waitFor(() =>
        expect((hub.hosts()[0]?.update as { state?: string } | null)?.state).toBe('updating'),
      )
      const pending = call('POST', '/v1/roots', { host: 'vm', requestId: 'req-w2' })
      await new Promise((resolve) => setTimeout(resolve, 200))
      skew = 11_000
      const answer = await pending
      finish()
      expect(answer).toMatchObject({
        status: 409,
        body: {
          error: 'host_unavailable',
          reason: `vm's Tether is still being updated from API 20 to ${API_VERSION}`,
        },
      })
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

  it('drops reflected local roots and duplicate routes while keeping real indirect roots', async () => {
    localRoots.set('root-local', 'logical-local')
    peer.roots = [
      { requestId: 'root-local', hostIdentity: 'eeee0005', logicalSessionId: 'logical-local' },
      { requestId: 'root-local', hostIdentity: 'dddd0004', logicalSessionId: 'logical-other' },
      { requestId: 'root-remote', hostIdentity: 'aaaa0001' },
      { requestId: 'root-remote', hostIdentity: 'aaaa0001', host: 'another-route' },
      { requestId: 'root-worker', hostIdentity: 'bbbb0002', host: 'worker' },
    ]
    expect(await hub.roots('ended=0')).toEqual([
      {
        requestId: 'root-local',
        hostIdentity: 'dddd0004',
        logicalSessionId: 'logical-other',
        host: 'vm',
      },
      { requestId: 'root-remote', hostIdentity: 'aaaa0001', host: 'vm' },
      { requestId: 'root-worker', hostIdentity: 'bbbb0002', host: 'vm' },
    ])
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
