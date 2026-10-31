import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_ADMISSION_LIMITS } from '../lifecycle/agent-admission'
import type { RunResult } from './host-admin'
import type { HostEntry } from './hosts'
import {
  GUEST_LINE,
  judgeCapability,
  localRootFate,
  type Needs,
  type PeerView,
  Placement,
  type PlacementDeps,
  parseGuest,
  parseLocalAdmission,
  parseNeeds,
  parsePlacement,
  parsePool,
  type RootFate,
} from './placement'

const GIB = 1024 ** 3
const NOW = 1_800_000_000_000

function admission(state: 'green' | 'amber' | 'red', gib: number, expiresIn = 20): string {
  return JSON.stringify({
    v: 1,
    state,
    admit: state !== 'red',
    reason: `${state} test`,
    updated_at: NOW / 1000 - 5,
    expires_at: NOW / 1000 + expiresIn,
    mem_available_gib: gib,
  })
}

function guest(memGiB: number, psiSome = 0.5, cpus = 8, load5 = 1): string {
  const sep = '@@tether-placement@@\n'
  return [
    `MemTotal:       16000000 kB\nMemAvailable:   ${Math.round(memGiB * 1024 * 1024)} kB\n`,
    `some avg10=0.00 avg60=${psiSome.toFixed(2)} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`,
    `0.50 ${load5.toFixed(2)} 0.50 1/100 1234\n`,
    `${cpus}\n`,
  ].join(sep)
}

function proxmox(availGiB: number, status = 'running', maxGiB = 16, storageGiB = 300): string {
  const sep = '\n@@tether-placement@@\n'
  return [
    JSON.stringify({ memory: { available: availGiB * GIB, free: availGiB * GIB } }),
    JSON.stringify({ status, maxmem: maxGiB * GIB, cpus: 8 }),
    JSON.stringify({ avail: storageGiB * GIB }),
  ].join(sep)
}

const ENTRY: HostEntry = {
  name: 'vm',
  ssh: 'vm',
  socket: '/run/user/1000/tether/default/control.sock',
  forwards: [],
  wake: ['st', 'vm', 'start', '200'],
  sleep: null,
  status: null,
  statusOff: '\\bstopped\\b',
  health: [],
  wakeTimeoutSec: 240,
  stateDir: null,
}

const PVE = { ssh: 'pve', node: 'pve', vmid: 200, storage: 'local-lvm' }

interface World {
  admission: string | null
  guest: string
  proxmox: string
  peerLive: boolean
  peerState: string
  files: Record<string, string>
  fingerprint: RunResult
  local: Record<string, RootFate>
  remote: Record<string, RootFate>
  existing: Record<string, string | null>
  settings: Map<string, string>
  runs: string[][]
}

describe('placement', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setup(config: unknown, overrides: Partial<World> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'tether-placement-'))
    dirs.push(dir)
    const file = join(dir, 'placement.json')
    if (config !== null) writeFileSync(file, JSON.stringify(config))
    const world: World = {
      admission: admission('green', 20),
      guest: guest(12),
      proxmox: proxmox(20),
      peerLive: true,
      peerState: 'connected',
      files: {},
      fingerprint: { code: 0, stdout: 'fp-1\n', output: '' },
      local: {},
      remote: {},
      existing: {},
      settings: new Map(),
      runs: [],
      ...overrides,
    }
    const env = {
      TETHER_PLACEMENT_FILE: file,
      XDG_RUNTIME_DIR: '/run/test',
      HOME: '/home/test',
    }
    const deps = (): PlacementDeps => ({
      env,
      hostNames: () => ['vm'],
      peer: (name): PeerView | null =>
        name === 'vm'
          ? {
              entry: ENTRY,
              live: world.peerLive,
              state: world.peerState,
              socket: '/sock',
              control: '/ctl',
            }
          : null,
      localRoot: (id) => world.local[id] ?? 'live',
      existingHost: (id) => (id in world.existing ? world.existing[id] : undefined),
      settings: {
        get: (key) => world.settings.get(key) ?? null,
        put: (key, value) => world.settings.set(key, value),
      },
      readText: async (path) => {
        if (path === '/run/test/nightshift/admission.json' && world.admission !== null)
          return world.admission
        if (path in world.files) return world.files[path] as string
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      run: async (argv) => {
        world.runs.push(argv)
        const line = argv.at(-1) ?? ''
        if (argv[0] === '/usr/bin/ssh' && argv.includes('pve'))
          return { code: 0, stdout: world.proxmox, output: '' }
        if (line.includes(GUEST_LINE)) return { code: 0, stdout: world.guest, output: '' }
        if (line.includes('cat ') && line.includes('live-ready.json')) {
          const marker = world.files['vm:live-ready']
          return marker === undefined
            ? { code: 1, stdout: '', output: 'No such file' }
            : { code: 0, stdout: marker, output: '' }
        }
        return world.fingerprint
      },
      cpu: () => ({ cpus: 16, load5: 2 }),
      limits: () => DEFAULT_AGENT_ADMISSION_LIMITS,
      remoteRoot: async (_peer, id) => (world.peerLive ? (world.remote[id] ?? 'live') : 'unknown'),
      now: () => NOW,
      log: () => {},
    })
    return { world, deps, placement: new Placement(deps()) }
  }

  const needs = (memGiB: number, cpu = 1, caps: string[] = []): Needs => ({
    memBytes: memGiB * GIB,
    cpu,
    caps,
  })

  const CONFIG = {
    order: ['local', 'vm'],
    hosts: {
      local: { reserveGiB: 6, reserveCpu: 2 },
      vm: { reserveGiB: 2, reserveCpu: 1, proxmox: { ...PVE, reserveGiB: 2 } },
    },
  }

  it('parses needs strictly', () => {
    expect(parseNeeds({ memBytes: 6 * GIB, cpu: 2, caps: ['live-ready'] })).toEqual({
      memBytes: 6 * GIB,
      cpu: 2,
      caps: ['live-ready'],
    })
    expect(parseNeeds({ memBytes: 1 })).toEqual({ memBytes: 1, cpu: 0, caps: [] })
    for (const bad of [
      null,
      {},
      { memBytes: -1 },
      { memBytes: 1.5 },
      { memBytes: 1, cpu: -1 },
      { memBytes: 1, caps: ['Bad Cap'] },
      { memBytes: 1, extra: true },
    ])
      expect(parseNeeds(bad)).toBeNull()
  })

  it('reads config as data with defaults, and keeps a broken entry at the defaults', () => {
    const defaults = parsePlacement(null, ['vm', 'other'])
    expect(defaults.order).toEqual(['local', 'vm', 'other'])
    expect(defaults.hosts.local?.reserveBytes).toBe(6 * GIB)
    expect(defaults.capabilities['live-ready']?.fingerprint).toBeNull()
    const broken = parsePlacement(
      JSON.stringify({ order: ['vm'], hosts: { vm: { reserveGiB: -3 } } }),
      ['vm'],
    )
    expect(broken.order).toEqual(['vm', 'local'])
    expect(
      parsePlacement(JSON.stringify({ order: ['vm'], skip: ['local'] }), ['other', 'vm']).order,
    ).toEqual(['vm', 'other'])
    expect(broken.hosts.vm?.reserveBytes).toBe(2 * GIB)
    expect(broken.errors).toEqual(['hosts.vm: reserveGiB must be 0-4096; using the defaults'])
    expect(parsePlacement('{', []).errors).toEqual(['placement.json is not valid JSON'])
  })

  it('reads named pools: each holds only its hosts, and default leaves pooled hosts out', () => {
    const config = parsePlacement(
      JSON.stringify({ order: ['local'], pools: { 'neri-hunt': ['vm', 'gone'] }, skip: ['gone'] }),
      ['vm', 'other'],
    )
    expect(config.pools).toEqual({ 'neri-hunt': ['vm'], default: ['local', 'other'] })
    expect(config.order).toEqual(['local', 'other'])
    expect(config.hosts.vm?.reserveBytes).toBe(2 * GIB)
    expect(config.errors).toEqual([])
    // A pool may also be listed in default on purpose.
    const both = parsePlacement(
      JSON.stringify({ pools: { default: ['local', 'vm'], hunt: ['vm'] } }),
      ['vm'],
    )
    expect(both.pools).toEqual({ hunt: ['vm'], default: ['local', 'vm'] })
    const bad = parsePlacement(
      JSON.stringify({
        order: ['vm'],
        pools: { default: ['local'], 'Bad Pool': ['vm'], ok: 'vm' },
      }),
      ['vm'],
    )
    expect(bad.pools).toEqual({ default: ['local', 'vm'] })
    expect(bad.errors).toEqual([
      'pools.Bad Pool: a pool name is lowercase letters, digits and dashes',
      'pools.ok must be a list of host names',
      'order and pools.default are both set; using pools.default',
    ])
  })

  it('places from the chosen pool only, shares reservations across pools, and refuses an unknown pool', async () => {
    const { placement, world } = setup({ ...CONFIG, order: ['local'], pools: { hunt: ['vm'] } })
    // Default never reaches the pooled VM, even with no room here.
    world.admission = admission('green', 7)
    const general = await placement.place('g1', needs(4))
    expect(general.kind).toBe('at_capacity')
    expect(general.verdicts.map((v) => v.host)).toEqual(['local'])
    const hunt = await placement.place('h1', needs(4), 'hunt')
    expect(hunt).toMatchObject({ kind: 'placed', host: 'vm' })
    expect(hunt.verdicts.map((v) => v.host)).toEqual(['vm'])
    // 12 free - 2 reserve - 4 held (h1) = 6 room.
    expect((await placement.check(needs(4), 'hunt'))[0]?.room?.memGiB).toBe(6)
    expect(await placement.place('h2', needs(1), 'nope')).toEqual({
      kind: 'unknown_pool',
      pools: ['default', 'hunt'],
      verdicts: [],
    })
    await expect(placement.check(needs(1), 'nope')).rejects.toMatchObject({
      pool: 'nope',
      pools: ['default', 'hunt'],
    })
    expect(placement.list().map((item) => item.requestId)).toEqual(['h1'])
    expect([parsePool(undefined), parsePool('neri-hunt'), parsePool('Bad'), parsePool(3)]).toEqual([
      'default',
      'neri-hunt',
      null,
      null,
    ])
  })

  it('reads the Nightshift file only while it is fresh', () => {
    expect(parseLocalAdmission(admission('green', 20), NOW)).toMatchObject({
      state: 'green',
      memAvailableBytes: 20 * GIB,
    })
    expect(parseLocalAdmission(admission('green', 20, -1), NOW)).toBeNull()
    expect(parseLocalAdmission('not json', NOW)).toBeNull()
    expect(parseGuest(guest(4)).memAvailableBytes).toBe(4 * GIB)
  })

  it('places on this computer when green leaves room after the reserve', async () => {
    const { placement } = setup(CONFIG)
    const result = await placement.place('r1', needs(6, 2))
    expect(result).toMatchObject({ kind: 'placed', host: null })
    expect(result.verdicts[0]).toMatchObject({ host: 'local', fits: true, room: { memGiB: 14 } })
    // The first fit wins: the VM is not even read.
    expect(result.verdicts).toHaveLength(1)
    expect(placement.list()).toEqual([expect.objectContaining({ requestId: 'r1', host: 'local' })])
  })

  it('never places on amber, red, a stale or a missing reading', async () => {
    for (const reading of [
      admission('amber', 30),
      admission('red', 30),
      admission('green', 30, -5),
      null,
    ]) {
      const { placement } = setup(
        { ...CONFIG, order: ['local'], skip: ['vm'] },
        { admission: reading as string | null },
      )
      const result = await placement.place('r', needs(1))
      expect(result.kind).toBe('at_capacity')
      expect(result.verdicts[0]).toMatchObject({ host: 'local', fits: false, room: null })
    }
  })

  it('subtracts the reserve and held reservations, and goes to the next host', async () => {
    const { placement } = setup(CONFIG)
    expect(await placement.place('a', needs(8))).toMatchObject({ host: null })
    const second = await placement.place('b', needs(8))
    // 20 free - 6 reserve - 8 held = 6 < 8: the VM (12 - 2 = 10, Proxmox 20 - 2 - 0) takes it.
    expect(second).toMatchObject({ kind: 'placed', host: 'vm' })
    expect(second.verdicts[0]?.reason).toMatch(/needs 8.0 GiB, has 6.0 GiB room/)
    const third = await placement.place('c', needs(9))
    expect(third.kind).toBe('at_capacity')
    expect(third.verdicts.map((v) => v.host)).toEqual(['local', 'vm'])
    expect(third.verdicts[1]?.reason).toMatch(/needs 9.0 GiB, has 2.0 GiB room/)
  })

  it('cannot double-book under concurrent creates', async () => {
    const { placement } = setup({ ...CONFIG, order: ['local'], skip: ['vm'] })
    const results = await Promise.all(['x1', 'x2', 'x3'].map((id) => placement.place(id, needs(6))))
    expect(results.map((r) => r.kind)).toEqual(['placed', 'placed', 'at_capacity'])
  })

  it('holds a reservation until the owning Tether reports a definite end', async () => {
    const { world, deps, placement } = setup({ ...CONFIG, order: ['local'], skip: ['vm'] })
    const first = await placement.place('long', needs(12))
    if (first.kind !== 'placed') throw new Error('expected placed')
    first.done()
    // Still running: held however long it takes.
    expect((await placement.place('next', needs(4))).kind).toBe('at_capacity')
    // Restart: the reservation comes back from settings.
    const restarted = new Placement(deps())
    expect(restarted.list()).toEqual([expect.objectContaining({ requestId: 'long' })])
    world.local.long = 'exited'
    expect(await restarted.place('next', needs(4))).toMatchObject({ kind: 'placed', host: null })
    expect(restarted.list().map((r) => r.requestId)).toEqual(['next'])
  })

  it('frees a refused create at once, but never while its create runs', async () => {
    const { world, placement } = setup({ ...CONFIG, order: ['local'], skip: ['vm'] })
    world.local.refused = 'missing'
    const placed = await placement.place('refused', needs(12))
    if (placed.kind !== 'placed') throw new Error('expected placed')
    // In flight: a missing root is not a definite end yet.
    expect((await placement.place('other', needs(4))).kind).toBe('at_capacity')
    placed.done()
    expect(await placement.place('other', needs(4))).toMatchObject({ kind: 'placed' })
  })

  it('keeps a remote reservation while its host cannot answer', async () => {
    const { world, placement } = setup({ ...CONFIG, order: ['vm'], skip: ['local'] })
    const placed = await placement.place('far', needs(8))
    if (placed.kind !== 'placed') throw new Error('expected placed')
    placed.done()
    world.peerLive = false
    world.peerState = 'offline'
    world.remote.far = 'ended'
    expect(await placement.check(needs(1))).toEqual([
      expect.objectContaining({
        host: 'vm',
        fits: false,
        reason: 'running but its link is offline',
      }),
    ])
    expect(placement.list()).toHaveLength(1)
    world.peerLive = true
    world.peerState = 'connected'
    await placement.check(needs(1))
    expect(placement.list()).toHaveLength(0)
  })

  it('sends a retry to the host it already chose, without a new reservation', async () => {
    const { world, placement } = setup(CONFIG)
    await placement.place('same', needs(1))
    expect(await placement.place('same', needs(1))).toMatchObject({ kind: 'placed', host: null })
    world.existing.elsewhere = 'vm'
    expect(await placement.place('elsewhere', needs(100))).toMatchObject({ host: 'vm' })
    expect(placement.list()).toHaveLength(1)
  })

  it('counts a powered-off VM only when Proxmox has room to start it', async () => {
    const off = { peerLive: false, peerState: 'powered_off' }
    const roomy = setup(
      { ...CONFIG, order: ['vm'], skip: ['local'] },
      { ...off, proxmox: proxmox(19, 'stopped') },
    )
    const placed = await roomy.placement.place('wake', needs(6))
    expect(placed).toMatchObject({ kind: 'placed', host: 'vm' })
    expect(placed.verdicts[0]).toMatchObject({ wake: true, room: { memGiB: 14 } })
    const tight = setup(
      { ...CONFIG, order: ['vm'], skip: ['local'] },
      { ...off, proxmox: proxmox(17, 'stopped') },
    )
    const full = await tight.placement.place('wake', needs(1))
    expect(full.kind).toBe('at_capacity')
    expect(full.verdicts[0]?.reason).toMatch(/powered off; starting it needs 16.0 GiB/)
  })

  it('takes the smaller of the VM and Proxmox room, and refuses low storage or pressure', async () => {
    const tightNode = setup({ ...CONFIG, order: ['vm'], skip: ['local'] }, { proxmox: proxmox(5) })
    const verdict = (await tightNode.placement.check(needs(4)))[0]
    expect(verdict).toMatchObject({ fits: false, room: { memGiB: 3 } })
    const disk = setup(
      { ...CONFIG, order: ['vm'], skip: ['local'] },
      { proxmox: proxmox(20, 'running', 16, 5) },
    )
    expect((await disk.placement.check(needs(1)))[0]?.reason).toMatch(/storage local-lvm has 5.0/)
    const busy = setup({ ...CONFIG, order: ['vm'], skip: ['local'] }, { guest: guest(12, 25) })
    expect((await busy.placement.check(needs(1)))[0]?.reason).toMatch(/memory pressure/)
    const broken = setup({ ...CONFIG, order: ['vm'], skip: ['local'] }, { guest: 'garbage' })
    expect((await broken.placement.check(needs(1)))[0]).toMatchObject({ fits: false, room: null })
  })

  it('needs a live-ready marker whose fingerprint matches the current one', async () => {
    const caps = {
      'live-ready': {
        marker: '.local/state/neri-proxy/live-ready.json',
        fingerprint: ['neri', 'fingerprint'],
      },
    }
    const config = { ...CONFIG, order: ['local', 'vm'], capabilities: caps }
    const marker = JSON.stringify({ v: 1, suite_version: '1', passed_at: 1, fingerprint: 'fp-1' })
    // No marker anywhere: not live-ready, so nowhere.
    const none = setup(config)
    const missing = await none.placement.place('h', needs(1, 1, ['live-ready']))
    expect(missing.kind).toBe('at_capacity')
    expect(missing.verdicts.map((v) => v.reason)).toEqual([
      'not live-ready: no marker',
      'not live-ready: no marker',
    ])
    // The VM's marker matches its current fingerprint; this computer's does not.
    const some = setup(config, {
      files: {
        '/home/test/.local/state/neri-proxy/live-ready.json': marker.replace('fp-1', 'fp-0'),
        'vm:live-ready': marker,
      },
    })
    const placed = await some.placement.place('h', needs(1, 1, ['live-ready']))
    expect(placed).toMatchObject({ kind: 'placed', host: 'vm' })
    expect(placed.verdicts[0]?.reason).toBe(
      'not live-ready: the fingerprint changed since the suite passed',
    )
    expect((await some.placement.check(needs(1, 1, ['gpu'])))[0]?.reason).toBe(
      'unknown capability gpu',
    )
  })

  it('ends a local root only when it is gone or its agent exited, not while it runs', () => {
    expect(localRootFate(false, false, null)).toBe('missing')
    expect(localRootFate(true, false, null)).toBe('ended')
    expect(localRootFate(true, true, 'started')).toBe('live')
    expect(localRootFate(true, true, null)).toBe('live')
    expect(localRootFate(true, true, 'exit')).toBe('exited')
    expect(localRootFate(true, true, 'signal')).toBe('exited')
  })

  it('treats a marker it cannot compare as not ready', () => {
    const probe = { marker: 'm', fingerprint: null }
    expect(judgeCapability('live-ready', probe, '{"fingerprint":"a"}', null)).toEqual({
      ok: false,
      reason: 'not live-ready: no fingerprint command is configured to compare',
    })
    const withCommand = { marker: 'm', fingerprint: ['x'] }
    expect(
      judgeCapability('live-ready', withCommand, '{"fingerprint":"a"}', {
        code: 1,
        stdout: '',
        output: 'boom',
      }),
    ).toEqual({ ok: false, reason: 'not live-ready: the fingerprint command failed (boom)' })
    expect(
      judgeCapability('live-ready', withCommand, '{"fingerprint":"a"}', {
        code: 0,
        stdout: 'a\n',
        output: '',
      }),
    ).toEqual({ ok: true })
  })
})
