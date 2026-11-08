import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hub, HubDeps } from '@aico/fleet/hub/hub'
import { Placement } from '@aico/fleet/hub/placement'
import { FakePeer, frontServer, makeTestHub, session } from '@aico/fleet/hub/testing'
import { peerRequest } from '@aico/fleet/peer-http'
import { EventBus } from '@aico/session-engine/events'
import { resolvePaths } from '@aico/session-engine/paths'
import { createRootHandler } from '@aico/session-engine/root-control'
import { initStore } from '@aico/session-engine/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootOperations } from '../lifecycle-api'
import { ProjectProvider } from '../projects'
import { tetherHubPorts } from './ports'

// The hub on Tether's own ports, in front of the engine's root handler and the placement
// that reserves room: the parts of the hub's tests that need a real catalog (the rest are
// @aico/fleet's hub.test.ts).
describe('hub with the engine', () => {
  let dir: string
  let peer: FakePeer
  let hub: Hub
  let front: Server
  let frontSocket: string
  let events: { type: string; data: Record<string, unknown> }[]
  let settings: Map<string, string>
  let rootHandler: ReturnType<typeof createRootHandler> | null
  const local = new Set<string>(['eeee0005'])
  const localRoots = new Map<string, string>()

  function makeHub(overrides: Partial<HubDeps> = {}): Hub {
    return makeTestHub(
      { dir, ports: tetherHubPorts, events, settings, local, localRoots },
      overrides,
    )
  }

  async function call(method: string, path: string, payload?: unknown) {
    return peerRequest(frontSocket, method, path, payload, 5_000)
  }

  const state = () => hub.hosts()[0]?.state

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tether-hub-'))
    events = []
    settings = new Map()
    localRoots.clear()
    rootHandler = null
    writeFileSync(
      join(dir, 'hosts.json'),
      JSON.stringify([
        { name: 'vm', ssh: 'vm', socket: '/run/user/1000/tether/default/control.sock' },
      ]),
    )
    const peerDirectory = join(dir, 'aico', 'fleet', 'vm')
    mkdirSync(peerDirectory, { recursive: true })
    peer = new FakePeer(join(peerDirectory, 'control.sock'))
    peer.sessions = [session('aaaa0001', { rootRequestId: 'root-a', wakes: [{ id: 'wake-1' }] })]
    await peer.start()
    hub = makeHub()
    frontSocket = join(dir, 'front.sock')
    front = frontServer(
      () => hub,
      () => rootHandler,
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

  describe('named create with room admission', () => {
    const gib = 1024 ** 3
    let waiting: Promise<void>
    let resume: () => void
    let connect: () => void
    let memGiB: number
    let cpus: number
    let placement: Placement
    let gateRuns: string[][]

    beforeEach(async () => {
      hub.close()
      let entered = () => {}
      waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      const released = new Promise<void>((resolve) => {
        resume = resolve
      })
      peer.healthReady = new Promise<void>((resolve) => {
        connect = resolve
      })
      let now = Date.now()
      gateRuns = []
      writeFileSync(join(dir, 'hosts.json'), '[]')
      hub = makeHub({
        gate: {
          run: async (argv) => {
            gateRuns.push(argv)
            return { code: 0, output: '' }
          },
          kick: () => {},
          now: () => now,
          sleep: async (ms) => {
            entered()
            await released
            now += ms
          },
          linkGraceMs: 1_000,
        },
      })
      hub.start()
      // Provisioning added a running host after the hub's catalog read. Its
      // transport handshake is not complete; create must refresh and wait.
      writeFileSync(
        join(dir, 'hosts.json'),
        JSON.stringify([{ name: 'vm', ssh: 'vm', socket: '/synthetic/control.sock' }]),
      )
      const file = join(dir, 'placement.json')
      writeFileSync(file, JSON.stringify({ hosts: { vm: { room: 'local' } } }))
      memGiB = 20
      cpus = 16
      placement = new Placement({
        env: { TETHER_PLACEMENT_FILE: file, HOME: dir, XDG_RUNTIME_DIR: dir },
        hostNames: () => hub.hostNames(),
        peer: (name) => hub.peerView(name),
        localRoot: () => 'missing',
        existingHost: () => undefined,
        settings: {
          get: (key) => settings.get(key) ?? null,
          put: (key, value) => settings.set(key, value),
        },
        readText: async () =>
          JSON.stringify({
            v: 1,
            state: 'green',
            admit: true,
            updated_at: now / 1_000,
            expires_at: now / 1_000 + 30,
            mem_available_gib: memGiB,
          }),
        cpu: () => ({ cpus, load5: 2 }),
        remoteRoot: async () => 'live',
        now: () => now,
        run: async () => {
          throw new Error('synthetic shared room needs no external command')
        },
        log: () => {},
      })
      const operations = rootOperations({
        paths: resolvePaths({ home: dir, env: { XDG_RUNTIME_DIR: dir }, uid: 1000 }),
        store: initStore(join(dir, 'catalog.db')),
        events: new EventBus(),
        projects: new ProjectProvider({
          localFile: join(dir, 'projects.json'),
        }),
        projectRoots: new Map(),
        hub,
        placement,
      })
      operations.ensure = async () => {
        throw new Error('synthetic remote create must never launch locally')
      }
      rootHandler = createRootHandler(operations)
    })

    afterEach(() => {
      resume()
      connect()
    })

    const create = (requestId = 'named-ready') =>
      call('POST', '/v1/roots', {
        requestId,
        tool: 'codex',
        projectId: 'synthetic',
        projectRoot: dir,
        initialPrompt: 'Synthetic peer only.',
        role: 'lead',
        host: 'vm',
        needs: { memBytes: 4 * gib, cpu: 1 },
      })

    it.each(['fits', 'memory full', 'CPU full'])(
      'waits for the new named transport before judging room: %s',
      async (room) => {
        if (room === 'memory full') memGiB = 7
        if (room === 'CPU full') cpus = 4
        hub.reload()
        expect(state()).toBe('connecting')
        const pending = create()
        expect(await Promise.race([waiting.then(() => 'waiting'), pending])).toBe('waiting')
        expect(peer.requests.some((r) => r.method === 'POST')).toBe(false)
        expect(placement.list()).toEqual([])
        connect()
        await vi.waitFor(() => expect(state()).toBe('connected'))
        resume()
        const answer = await pending
        if (room === 'fits') {
          expect(answer).toMatchObject({ status: 201, body: { host: 'vm' } })
          expect(placement.list()).toMatchObject([{ requestId: 'named-ready', host: 'vm' }])
          expect(peer.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
        } else {
          expect(answer).toMatchObject({
            status: 409,
            body: {
              error: 'at_capacity',
              hosts: [{ host: 'vm', reason: expect.stringContaining('needs') }],
            },
          })
          expect(peer.requests.some((r) => r.method === 'POST')).toBe(false)
          expect(placement.list()).toEqual([])
        }
      },
    )

    it('refreshes the named catalog miss before waiting and placing', async () => {
      expect(hub.hostNames()).toEqual([])
      const pending = create()
      expect(await Promise.race([waiting.then(() => 'waiting'), pending])).toBe('waiting')
      connect()
      await vi.waitFor(() => expect(state()).toBe('connected'))
      resume()
      expect(await pending).toMatchObject({ status: 201, body: { host: 'vm' } })
    })

    it('serializes room reservations after concurrent creates share readiness', async () => {
      memGiB = 11 // 5 GiB after the owner reserve: only one 4 GiB root fits.
      hub.reload()
      const pending = Promise.all([create('first'), create('second')])
      expect(await Promise.race([waiting.then(() => 'waiting'), pending])).toBe('waiting')
      connect()
      await vi.waitFor(() => expect(state()).toBe('connected'))
      resume()
      const answers = await pending
      expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409])
      expect(answers.find((answer) => answer.status === 409)?.body).toMatchObject({
        error: 'at_capacity',
      })
      expect(placement.list()).toHaveLength(1)
      expect(peer.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
    })

    it('refuses a full powered-off host before waking or reserving it', async () => {
      writeFileSync(
        join(dir, 'hosts.json'),
        JSON.stringify([
          { name: 'vm', ssh: 'vm', socket: '/synthetic/control.sock', wake: ['synthetic-wake'] },
        ]),
      )
      hub.reload()
      hub.markPoweredOff('vm')
      memGiB = 7
      expect(await create()).toMatchObject({ status: 409, body: { error: 'at_capacity' } })
      expect(gateRuns).toEqual([])
      expect(placement.list()).toEqual([])
      expect(peer.requests.some((r) => r.method === 'POST')).toBe(false)
    })

    it('keeps the readiness failure reason and reserves or forwards nothing', async () => {
      hub.reload()
      resume()
      expect(await create()).toMatchObject({
        status: 409,
        body: {
          error: 'host_unavailable',
          host: 'vm',
          reason: 'vm is not reachable and has no wake command',
        },
      })
      expect(placement.list()).toEqual([])
      expect(peer.requests.some((r) => r.method === 'POST')).toBe(false)
    })
  })

  it('stops repeat root federation hops when a peer routes back to the same handler', async () => {
    initStore(join(dir, 'root-loop.db'))
    let federations = 0
    peer.rootListHandler = createRootHandler({
      available: () => true,
      validate: () => true,
      ensure: async () => {},
      mutate: async () => false,
      status: async () => 'running',
      remoteRoots: async (search) => {
        federations += 1
        // Fail fast on the old recursive path instead of waiting for its
        // nested peer deadlines; the real socket/handler chain stays intact.
        if (federations > 1) return []
        return [
          {
            requestId: 'worker-root',
            logicalSessionId: 'worker-logical',
            hostIdentity: 'abcd0001',
            host: 'worker',
          },
          ...(await hub.roots(search)),
        ]
      },
    })
    expect(await hub.roots('ended=0')).toEqual([
      {
        requestId: 'worker-root',
        logicalSessionId: 'worker-logical',
        hostIdentity: 'abcd0001',
        host: 'vm',
      },
    ])
    expect(federations).toBe(1)
  })
})
