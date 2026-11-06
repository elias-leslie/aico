import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostEntry } from '@aico/fleet/hosts'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_ADMISSION_LIMITS } from '../lifecycle/agent-admission'
import type { RunResult } from './host-admin'
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

/** host-steward's admission.json with disk red and memory green, as memctl
 * writes it (host-steward memctl), made fresh. */
function diskRed(nowMs: number): string {
  const doc = JSON.parse(
    readFileSync(new URL('../test-fixtures/host-admission-disk-red.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
  return JSON.stringify({ ...doc, expires_at: Math.floor(nowMs / 1000) + 30 })
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
  sync: null,
  wake: ['st', 'vm', 'start', '200'],
  sleep: null,
  status: null,
  statusOff: '\\bstopped\\b',
  health: [],
  wakeTimeoutSec: 240,
  stateDir: null,
}

const BOX: HostEntry = {
  ...ENTRY,
  name: 'box',
  ssh: 'box',
  wake: ['neri-hunt-box', 'up', '1'],
  status: ['neri-hunt-box', 'status', '1'],
}

const PVE = { ssh: 'pve', node: 'pve', vmid: 200, storage: 'local-lvm' }

interface World {
  admission: string | null
  guest: string
  /** null: the Proxmox host does not answer (ssh fails). */
  proxmox: string | null
  peerLive: boolean
  peerState: string
  hosts: string[]
  box: { live: boolean; state: string; entry: HostEntry }
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
      hosts: ['vm'],
      box: { live: true, state: 'connected', entry: BOX },
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
      hostNames: () => world.hosts,
      peer: (name): PeerView | null =>
        name === 'pve'
          ? {
              entry: { ...ENTRY, name: 'pve' },
              live: true,
              state: 'connected',
              socket: '/pve-sock',
              control: '/pve-ctl',
            }
          : name === 'vm'
            ? {
                entry: ENTRY,
                live: world.peerLive,
                state: world.peerState,
                socket: '/sock',
                control: '/ctl',
              }
            : name === 'box' && world.hosts.includes('box')
              ? { ...world.box, socket: '/box-sock', control: '/box-ctl' }
              : null,
      localRoot: (id) => world.local[id] ?? 'live',
      existingHost: (id) => (id in world.existing ? world.existing[id] : undefined),
      settings: {
        get: (key) => world.settings.get(key) ?? null,
        put: (key, value) => world.settings.set(key, value),
      },
      readText: async (path) => {
        if (path === '/run/test/host-steward/admission.json' && world.admission !== null)
          return world.admission
        if (path in world.files) return world.files[path] as string
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      run: async (argv) => {
        world.runs.push(argv)
        const line = argv.at(-1) ?? ''
        if (argv.includes('/pve-ctl'))
          return world.proxmox === null
            ? {
                code: 255,
                stdout: '',
                output: 'ssh: connect to host pve port 22: No route to host',
              }
            : { code: 0, stdout: world.proxmox, output: '' }
        if (line.includes(GUEST_LINE)) return { code: 0, stdout: world.guest, output: '' }
        if (line.includes('cat ') && line.includes('live-ready.json')) {
          const marker = world.files[argv.includes('/box-ctl') ? 'box:live-ready' : 'vm:live-ready']
          return marker === undefined
            ? { code: 1, stdout: '', output: 'No such file' }
            : { code: 0, stdout: marker, output: '' }
        }
        return world.fingerprint
      },
      cpu: () => ({ cpus: 16, load5: 2 }),
      limits: () => DEFAULT_AGENT_ADMISSION_LIMITS,
      remoteRoot: async (peer, id) =>
        (peer.entry.name === 'box' ? world.box.live : world.peerLive)
          ? (world.remote[id] ?? 'live')
          : 'unknown',
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

  it('reads the host-steward file only while it is fresh', () => {
    expect(parseLocalAdmission(admission('green', 20), NOW)).toMatchObject({
      state: 'green',
      memAvailableBytes: 20 * GIB,
    })
    expect(parseLocalAdmission(admission('green', 20, -1), NOW)).toBeNull()
    expect(parseLocalAdmission('not json', NOW)).toBeNull()
    expect(parseGuest(guest(4)).memAvailableBytes).toBe(4 * GIB)
  })

  it('refuses this computer while The host says disk red, with memory green', async () => {
    expect(parseLocalAdmission(diskRed(NOW), NOW)).toMatchObject({ state: 'red' })
    const { placement } = setup(CONFIG, { admission: diskRed(NOW) })
    const result = await placement.place('r1', needs(1))
    const local = result.verdicts.find((verdict) => verdict.host === 'local')
    expect(local).toMatchObject({ fits: false })
    expect(local?.reason).toContain('The host says red: Disk is critical')
    expect(result).not.toMatchObject({ kind: 'placed', host: null }) // never this computer
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
    expect(await placement.place('elsewhere', needs(100))).toMatchObject({
      kind: 'placed',
      host: 'vm',
    })
    expect(placement.list()).toHaveLength(1)
  })

  it('a repeat create for a known root without a booking is no capacity question', async () => {
    const { world, placement } = setup(CONFIG, { admission: admission('red', 20) })
    world.existing.gone = null
    // An ended or exited root: the create's own answer (no-op or 410) decides.
    expect(await placement.place('gone', needs(100))).toMatchObject({ kind: 'placed', host: null })
    expect(placement.list()).toEqual([])
    // Restore still judges it, so a full host refuses the rebooking.
    expect(await placement.place('gone', needs(100), undefined, undefined, true)).toMatchObject({
      kind: 'at_capacity',
    })
  })

  it('rebooks a known root on its original host when its reservation vanished', async () => {
    const { world, placement } = setup(CONFIG)
    world.existing.recover = null
    const booked = await placement.place('recover', needs(2, 1), undefined, undefined, true)
    expect(booked).toMatchObject({ kind: 'placed', host: null })
    if (booked.kind === 'placed') booked.done()
    expect(placement.list()).toMatchObject([
      { requestId: 'recover', memBytes: 2 * GIB, cpu: 1, state: 'held' },
    ])
    expect(await placement.place('recover', needs(2), 'default', 'vm')).toMatchObject({
      kind: 'placed_elsewhere',
      host: 'local',
    })
  })

  it('retains placement needs across a lost booking and delayed host readiness', async () => {
    const original = setup(CONFIG)
    const first = await original.placement.place('reboot', needs(2, 1))
    if (first.kind === 'placed') first.done()
    original.world.settings.set('placement_reservations', '[]')
    const rebooted = setup(CONFIG, {
      settings: original.world.settings,
      existing: { reboot: null },
      admission: admission('red', 20),
    })
    expect(await rebooted.placement.restore('reboot')).toMatchObject({ kind: 'at_capacity' })
    expect(rebooted.placement.list()).toEqual([])
    rebooted.world.admission = admission('green', 20)
    const restored = await rebooted.placement.restore('reboot')
    expect(restored).toMatchObject({ kind: 'placed', host: null })
    if (restored?.kind === 'placed') restored.done()
    expect(rebooted.placement.list()).toMatchObject([
      { requestId: 'reboot', memBytes: 2 * GIB, cpu: 1 },
    ])
    rebooted.world.local.reboot = 'ended'
    await rebooted.placement.check(needs(0))
    expect(await rebooted.placement.restore('reboot')).toBeNull()
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

  it("drops a powered-off VM's held reservations, so it can be picked and woken again", async () => {
    const { world, placement } = setup({ ...CONFIG, order: ['vm'], skip: ['local'] })
    // 8 GiB held on vm, which is later powered off with the root already ended.
    const done = await placement.place('gone', needs(8))
    if (done.kind !== 'placed') throw new Error('expected placed')
    done.done()
    world.remote.gone = 'unknown'
    const flight = await placement.place('flight', needs(1))
    expect(flight).toMatchObject({ kind: 'placed', host: 'vm' })
    world.peerLive = false
    world.peerState = 'powered_off'
    world.proxmox = proxmox(19, 'stopped')
    // Without the drop, 8 + 1 GiB held leaves Proxmox 8 GiB room, under the 16 GiB start.
    const verdict = (await placement.check(needs(6)))[0]
    expect(verdict).toMatchObject({ host: 'vm', fits: true, wake: true })
    // The create still in flight keeps its reservation.
    expect(placement.list().map((item) => item.requestId)).toEqual(['flight'])
    expect(JSON.parse(world.settings.get('placement_reservations') ?? '[]')).toHaveLength(1)
  })

  it('releases the held reservations of a host taken out of hosts.json, and logs it', async () => {
    const retired = (requestId: string) => ({
      requestId,
      host: 'neri-box-1',
      memBytes: 4 * GIB,
      cpu: 2,
      at: NOW - 1,
      state: 'held',
    })
    const held = [retired('hunt-nh-a'), retired('hunt-nh-b'), { ...retired('vm-1'), host: 'vm' }]
    const { world, deps } = setup(
      { ...CONFIG, order: ['vm'], skip: ['local'] },
      {
        // vm is configured but offline: its reservation stays.
        peerLive: false,
        peerState: 'offline',
        settings: new Map([['placement_reservations', JSON.stringify(held)]]),
      },
    )
    const logs: string[] = []
    const placement = new Placement({
      ...deps(),
      retired: (name) => name === 'neri-box-1',
      log: (line) => logs.push(line),
    })
    await placement.check(needs(1))
    expect(placement.list().map((item) => item.requestId)).toEqual(['vm-1'])
    expect(JSON.parse(world.settings.get('placement_reservations') ?? '[]')).toHaveLength(1)
    expect(logs).toEqual([
      'released hunt-nh-a on neri-box-1 (host no longer in hosts.json)',
      'released hunt-nh-b on neri-box-1 (host no longer in hosts.json)',
    ])
  })

  it('keeps the reservations of a host the hub has no link for but did not retire', async () => {
    // A restart with a hosts.json it cannot parse, the file briefly gone, or
    // the hub turned off: no peer, yet the host's roots may still run.
    const held = ['hunt-nh-a', 'hunt-nh-b'].map((requestId) => ({
      requestId,
      host: 'neri-box-1',
      memBytes: 4 * GIB,
      cpu: 2,
      at: NOW - 1,
      state: 'held',
    }))
    const { world, deps } = setup(
      { ...CONFIG, order: ['vm'], skip: ['local'] },
      { settings: new Map([['placement_reservations', JSON.stringify(held)]]) },
    )
    for (const retired of [undefined, () => false]) {
      const logs: string[] = []
      const placement = new Placement({
        ...deps(),
        ...(retired ? { retired } : {}),
        log: (line) => logs.push(line),
      })
      await placement.check(needs(1))
      expect(placement.list().map((item) => item.requestId)).toEqual(['hunt-nh-a', 'hunt-nh-b'])
      expect(JSON.parse(world.settings.get('placement_reservations') ?? '[]')).toHaveLength(2)
      expect(logs.filter((line) => line.startsWith('released'))).toEqual([])
    }
  })

  it('goes to the next pool host when the Proxmox host cannot be read', async () => {
    const { world, placement } = setup(
      { ...CONFIG, order: ['local'], pools: { hunt: ['vm', 'local'] } },
      { proxmox: null, peerLive: false, peerState: 'offline' },
    )
    const placed = await placement.place('h1', needs(4), 'hunt')
    // host null is this computer.
    expect(placed).toMatchObject({ kind: 'placed', host: null })
    expect(placed.verdicts.map((v) => v.host)).toEqual(['vm', 'local'])
    expect(placement.list()).toEqual([expect.objectContaining({ requestId: 'h1', host: 'local' })])
    expect(placed.verdicts[0]).toMatchObject({ fits: false, room: null })
    expect(placed.verdicts[0]?.reason).toMatch(
      /^the Proxmox reading failed \(ssh: connect to host pve/,
    )
    // Never woken or read over its link while Proxmox is unreadable.
    expect(world.runs.some((argv) => (argv.at(-1) ?? '').includes(GUEST_LINE))).toBe(false)
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

  const ROOM = {
    order: ['local'],
    pools: { hunt: ['box'] },
    hosts: { local: { reserveGiB: 6, reserveCpu: 2 }, box: { room: 'local' } },
  }

  it('reads room "local" for hosts on this computer, with no reserve of their own by default', () => {
    const config = parsePlacement(
      JSON.stringify({ ...ROOM, hosts: { ...ROOM.hosts, big: { room: 'local', reserveGiB: 1 } } }),
      ['box', 'big', 'vm'],
    )
    expect(config.hosts.box).toEqual({
      reserveBytes: 0,
      reserveCpu: 0,
      proxmox: null,
      room: 'local',
      capabilitiesOn: null,
    })
    expect(config.hosts.big?.reserveBytes).toBe(GIB)
    expect(config.hosts.vm?.room).toBeNull()
    expect(config.hosts.local?.room).toBeNull()
    expect(config.errors).toEqual([])
    const bad = parsePlacement(
      JSON.stringify({
        hosts: {
          local: { room: 'local' },
          a: { room: 'pve' },
          b: { room: 'local', proxmox: PVE },
          c: { room: 'local', capabilitiesOn: 'vm' },
          d: { capabilitiesOn: 'local' },
          e: { room: 'local', capabilitiesOn: 'local' },
        },
      }),
      ['a', 'b', 'c', 'd', 'e'],
    )
    expect(bad.errors).toEqual([
      'hosts.local: room is for hosts that share this computer; using the defaults',
      'hosts.a: room must be "local"; using the defaults',
      'hosts.b: room and proxmox do not go together; using the defaults',
      'hosts.c: capabilitiesOn must be "local"; using the defaults',
      'hosts.d: capabilitiesOn "local" goes with room "local"; using the defaults',
    ])
    expect(bad.hosts.e).toMatchObject({ room: 'local', capabilitiesOn: 'local' })
    // A broken room entry is an ordinary remote host at the remote defaults.
    expect(bad.hosts.b).toEqual({
      reserveBytes: 2 * GIB,
      reserveCpu: 1,
      proxmox: null,
      room: null,
      capabilitiesOn: null,
    })
  })

  it('judges a room "local" host by this computer, holding one room across it and local', async () => {
    const { world, placement } = setup(ROOM, { hosts: ['vm', 'box'] })
    const box = await placement.place('b1', needs(4), 'hunt')
    expect(box).toMatchObject({ kind: 'placed', host: 'box' })
    expect(box.verdicts).toEqual([
      {
        host: 'box',
        fits: true,
        reason:
          "14.0 GiB and 12 CPUs room (this computer's room: 20.0 free - 6.0 reserve - 0.0 held)",
        room: { memGiB: 14, cpu: 12 },
      },
    ])
    // Its own /proc would show this computer again: never read.
    expect(world.runs.some((argv) => (argv.at(-1) ?? '').includes(GUEST_LINE))).toBe(false)
    if (box.kind === 'placed') box.done()
    // This computer sees the box's reservation, and the box sees this computer's.
    const local = await placement.place('l1', needs(8))
    expect(local).toMatchObject({ kind: 'placed', host: null })
    expect(local.verdicts[0]?.reason).toBe(
      '10.0 GiB and 11 CPUs room (20.0 free - 6.0 reserve - 4.0 held)',
    )
    const full = await placement.place('b2', needs(4), 'hunt')
    expect(full).toEqual({
      kind: 'at_capacity',
      verdicts: [
        expect.objectContaining({
          host: 'box',
          reason:
            "needs 4.0 GiB, has 2.0 GiB room (this computer's room: 20.0 free - 6.0 reserve - 12.0 held)",
        }),
      ],
    })
    // Ended on the box's own Tether: released like any host's.
    world.remote.b1 = 'ended'
    expect(await placement.place('b2', needs(4), 'hunt')).toMatchObject({ host: 'box' })
    expect(placement.list().map((item) => item.requestId)).toEqual(['l1', 'b2'])
  })

  it('takes its own reserve on top, and is unknown when this computer is', async () => {
    const own = setup(
      { ...ROOM, hosts: { ...ROOM.hosts, box: { room: 'local', reserveGiB: 1, reserveCpu: 1 } } },
      { hosts: ['box'] },
    )
    expect((await own.placement.check(needs(1), 'hunt'))[0]).toMatchObject({
      fits: true,
      reason:
        "13.0 GiB and 11 CPUs room (this computer's room: 20.0 free - 6.0 reserve - 0.0 held - 1.0 own reserve)",
    })
    const amber = setup(ROOM, { hosts: ['box'], admission: admission('amber', 20) })
    expect((await amber.placement.check(needs(1), 'hunt'))[0]).toEqual({
      host: 'box',
      fits: false,
      reason: 'shares this computer: The host says amber: amber test',
      room: null,
    })
    const missing = setup(ROOM, { hosts: [] })
    expect((await missing.placement.check(needs(1), 'hunt'))[0]?.reason).toBe('not in hosts.json')
  })

  it('fits a sleeping room "local" host by this computer when it can be woken', async () => {
    const asleep = { live: false, state: 'powered_off', entry: BOX }
    const woken = setup(ROOM, { hosts: ['box'], box: asleep })
    const placed = await woken.placement.place('w', needs(4), 'hunt')
    expect(placed).toMatchObject({ kind: 'placed', host: 'box' })
    expect(placed.verdicts[0]).toMatchObject({
      wake: true,
      reason:
        "14.0 GiB and 12 CPUs room (powered off, starts in this computer's room: 20.0 free - 6.0 reserve - 0.0 held)",
    })
    const reasons = async (box: World['box'], caps: string[] = []) =>
      (await setup(ROOM, { hosts: ['box'], box }).placement.check(needs(1, 1, caps), 'hunt'))[0]
        ?.reason
    expect(await reasons(asleep, ['live-ready'])).toBe(
      'powered off, so live-ready cannot be checked',
    )
    expect(await reasons({ ...asleep, entry: { ...BOX, wake: null } })).toBe(
      'powered off and hosts.json has no wake',
    )
    expect(await reasons({ ...asleep, state: 'offline' })).toBe('running but its link is offline')
  })

  it('reads a running room "local" host\'s capabilities over its link', async () => {
    const caps = {
      'live-ready': {
        marker: '.local/state/neri-proxy/live-ready.json',
        fingerprint: ['neri', 'fingerprint'],
      },
    }
    const marker = JSON.stringify({ fingerprint: 'fp-1' })
    const ready = setup(
      { ...ROOM, capabilities: caps },
      { hosts: ['box'], files: { 'box:live-ready': marker } },
    )
    expect(await ready.placement.place('c', needs(1, 1, ['live-ready']), 'hunt')).toMatchObject({
      kind: 'placed',
      host: 'box',
    })
    const none = setup({ ...ROOM, capabilities: caps }, { hosts: ['box'] })
    expect((await none.placement.check(needs(1, 1, ['live-ready']), 'hunt'))[0]?.reason).toBe(
      'not live-ready: no marker',
    )
  })

  it('probes this computer for a room "local" host whose capabilities it owns, asleep too', async () => {
    const caps = {
      'live-ready': {
        marker: '.local/state/neri-proxy/live-ready.json',
        fingerprint: ['neri', 'fingerprint'],
      },
    }
    const config = {
      ...ROOM,
      hosts: { ...ROOM.hosts, box: { room: 'local', capabilitiesOn: 'local' } },
      capabilities: caps,
    }
    const here = '/home/test/.local/state/neri-proxy/live-ready.json'
    const marker = JSON.stringify({ v: 1, suite_version: '1', passed_at: 1, fingerprint: 'fp-1' })
    const asleep = { live: false, state: 'powered_off', entry: BOX }
    const live = needs(2, 1, ['live-ready'])
    // Matching marker on this computer: a sleeping slot fits and is woken.
    const sleeping = setup(config, { hosts: ['box'], box: asleep, files: { [here]: marker } })
    const placed = await sleeping.placement.place('cap-1', live, undefined, 'box')
    expect(placed).toMatchObject({ kind: 'placed', host: 'box' })
    expect(placed.verdicts[0]).toMatchObject({ fits: true, wake: true })
    expect(sleeping.world.runs).toEqual([['neri', 'fingerprint']])
    // Running: still this computer's marker; the slot's own is never read.
    const running = setup(config, {
      hosts: ['box'],
      files: { [here]: marker, 'box:live-ready': marker.replace('fp-1', 'fp-0') },
    })
    expect((await running.placement.check(live, 'hunt'))[0]).toMatchObject({ fits: true })
    expect(running.world.runs.some((argv) => argv.includes('/box-ctl'))).toBe(false)
    // Missing or stale on this computer: unknown, asleep or not, whatever the slot has.
    const reason = async (world: Partial<World>) =>
      (await setup(config, { hosts: ['box'], ...world }).placement.check(live, 'hunt'))[0]
    expect(await reason({ box: asleep, files: { 'box:live-ready': marker } })).toEqual({
      host: 'box',
      fits: false,
      reason: 'checked on this computer: not live-ready: no marker',
      room: null,
    })
    const stale = await reason({ files: { [here]: marker.replace('fp-1', 'fp-0') } })
    expect(stale?.reason).toBe(
      'checked on this computer: not live-ready: the fingerprint changed since the suite passed',
    )
    const failed = { code: 1, stdout: '', output: 'proxy gone' }
    const broken = await reason({ box: asleep, files: { [here]: marker }, fingerprint: failed })
    expect(broken?.reason).toBe(
      'checked on this computer: not live-ready: the fingerprint command failed (proxy gone)',
    )
    // Without needs caps nothing is probed; without capabilitiesOn the slot's link is.
    const plain = setup(config, { hosts: ['box'], box: asleep })
    await plain.placement.check(needs(1), 'hunt')
    expect(plain.world.runs).toEqual([])
  })

  it('judges and reserves only a named host, whatever the pool order', async () => {
    const { world, placement } = setup(CONFIG)
    const named = await placement.place('n1', needs(4), undefined, 'vm')
    // `local` fits first in order, but the create named the VM.
    expect(named).toMatchObject({ kind: 'placed', host: 'vm' })
    expect(named.verdicts.map((v) => v.host)).toEqual(['vm'])
    if (named.kind === 'placed') named.done()
    expect(placement.list()).toEqual([expect.objectContaining({ requestId: 'n1', host: 'vm' })])
    // A retry to the same host holds nothing new; one naming another host is refused.
    expect(await placement.place('n1', needs(4), undefined, 'vm')).toMatchObject({
      kind: 'placed',
      host: 'vm',
      verdicts: [],
    })
    expect(await placement.place('n1', needs(4), undefined, 'local')).toEqual({
      kind: 'placed_elsewhere',
      host: 'vm',
      verdicts: [],
    })
    expect(placement.list()).toHaveLength(1)
    // No room there: at capacity with that host's reason only, nothing held.
    const full = await placement.place('n2', needs(100), undefined, 'vm')
    expect(full).toEqual({
      kind: 'at_capacity',
      verdicts: [expect.objectContaining({ host: 'vm', fits: false })],
    })
    expect(full.verdicts[0]?.reason).toMatch(/^needs 100.0 GiB, has 6.0 GiB room/)
    expect(await placement.place('n3', needs(1), undefined, 'nope')).toEqual({
      kind: 'unknown_host',
      host: 'nope',
      verdicts: [],
    })
    expect(await placement.place('n4', needs(1), undefined, 'local')).toMatchObject({
      kind: 'placed',
      host: null,
    })
    // Released only on a definite end from the host that owns it.
    world.remote.n1 = 'exited'
    await placement.check(needs(1))
    expect(placement.list().map((item) => item.requestId)).toEqual(['n4'])
    // Its own Tether brought the agent back: the hub books its needs again.
    world.remote.n1 = 'live'
    await placement.check(needs(1))
    expect(placement.list().map((item) => item.requestId)).toEqual(['n4', 'n1'])
    expect(placement.list().find((item) => item.requestId === 'n1')).toMatchObject({
      state: 'held',
    })
  })

  it('wakes a named sleeping VM like auto does, and names a room "local" host the same way', async () => {
    const vm = setup(
      { ...CONFIG, order: ['vm'], skip: ['local'] },
      { peerLive: false, peerState: 'powered_off', proxmox: proxmox(19, 'stopped') },
    )
    expect((await vm.placement.place('v', needs(6), undefined, 'vm')).verdicts[0]).toMatchObject({
      host: 'vm',
      fits: true,
      wake: true,
    })
    const box = setup(ROOM, { hosts: ['vm', 'box'] })
    const placed = await box.placement.place('b', needs(4), undefined, 'box')
    expect(placed).toMatchObject({ kind: 'placed', host: 'box' })
    expect(placed.verdicts.map((v) => v.host)).toEqual(['box'])
  })
})
