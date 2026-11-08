import { createServer, type Server } from 'node:http'
import type { Guest, GuestTask } from '@aico/fleet/power'
import { StatusStore } from '@aico/status'
import type { Place, Project } from '@aico/tasks'
import type { TetherClient } from '@aico/tether-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from './http'
import { MachinesService, registerMachineRoutes } from './machines'
import { type GuestSource, Places } from './places'

const T0 = Date.parse('2026-11-07T12:00:00Z')

const guest = (vmid: number, name: string, over: Partial<Guest> = {}): Guest => ({
  vmid,
  type: vmid === 150 ? 'lxc' : 'qemu',
  node: 'gem',
  name,
  status: 'stopped',
  uptime: 0,
  maxmem: 6 * 1024 * 1024 * 1024,
  maxcpu: 4,
  template: false,
  onboot: false,
  ...over,
})

const APPS: Place = {
  kind: 'vm',
  id: 180,
  label: 'VM 180',
  power: true,
  intent: 'on-demand',
  machine: 'apps',
}
const HUB: Place = {
  kind: 'ct',
  id: 150,
  label: 'CT 150',
  power: true,
  intent: 'always',
  machine: 'ominull-hub',
}
const AICO: Place = { ...HUB, id: 190, power: false, machine: 'aico' }
const project = (id: string, name: string, runtime: Place[]) =>
  ({ id, name, runtime }) as unknown as Project

function setup(link?: { state: string; sessions: number; canSleep?: boolean }) {
  const list = [
    guest(180, 'apps'),
    guest(150, 'ominull-hub', { status: 'running', uptime: 3600, onboot: true }),
    guest(190, 'aico', { type: 'lxc', status: 'running', uptime: 10, onboot: true }),
    guest(200, 'agent-work'),
    guest(9000, 'ubuntu-cloud', { template: true }),
  ]
  const calls: string[] = []
  const source: GuestSource & {
    down?: boolean
    refuse?: boolean
    stuck?: boolean
    outcome: GuestTask
  } = {
    outcome: { state: 'running' },
    async task() {
      return source.outcome
    },
    async list() {
      if (source.down) throw new Error('ssh: connect timed out')
      return list.map((g) => ({ ...g }))
    },
    async act(g, action) {
      calls.push(`${g.vmid}:${action}`)
      return `UPID:gem:${calls.length}`
    },
    async setOnboot(g, on) {
      if (source.refuse) throw new Error('permission denied')
      calls.push(`${g.vmid}:onboot=${on ? 1 : 0}`)
      // The reading is the truth: a write that does not stick reads back as it was.
      if (!source.stuck) list.find((candidate) => candidate.vmid === g.vmid)!.onboot = on
    },
  }
  const clock = { now: T0 }
  const status = new StatusStore(':memory:', () => clock.now)
  const projects = [
    project('portfolio-ai', 'Portfolio AI', [APPS]),
    project('ominull', 'OmniNull', [HUB]),
    project('aico', 'Aico', [AICO]),
  ]
  const places = new Places({
    guests: source,
    status,
    declared: () => projects.flatMap((p) => p.runtime),
    machine: 'davion-sidarli',
    pollMs: 30_000,
    busyMs: 600_000,
    now: () => clock.now,
  })
  const hosts = link ? [{ name: 'agent-work', ...link }] : []
  const request = vi.fn(async () => ({ host: 'agent-work', state: 'starting' }))
  const tether = { hosts: async () => hosts, request } as unknown as TetherClient
  const service = new MachinesService(places, { list: () => projects }, tether)
  return { service, places, source, calls, request, status, list, clock }
}

describe('MachinesService.guests', () => {
  it('lists each guest with autostart, intent, size and projects, and leaves templates out', async () => {
    const { service, places } = setup()
    await places.refresh()
    const { items, failure } = service.guests()
    expect(failure).toBeNull()
    expect(items.map((i) => i.vmid)).toEqual([180, 150, 190, 200])
    const apps = items.find((i) => i.machine === 'apps')
    expect(apps).toMatchObject({
      state: 'stopped',
      autostart: false,
      intent: 'on-demand',
      powerable: true,
      cpus: 4,
      memoryMb: 6144,
      projects: [{ id: 'portfolio-ai', name: 'Portfolio AI' }],
    })
    expect(items.find((i) => i.machine === 'ominull-hub')).toMatchObject({
      state: 'running',
      autostart: true,
      intent: 'always',
    })
    // A guest no project declares is named by Proxmox and has no intent; a place that says no stays unpowered.
    expect(items.find((i) => i.machine === 'agent-work')).toMatchObject({
      intent: null,
      powerable: true,
      projects: [],
    })
    expect(items.find((i) => i.machine === 'aico')?.powerable).toBe(false)
  })

  it('says autostart is unknown rather than off when Proxmox did not give it', async () => {
    const { service, places, list } = setup()
    delete list[0]!.onboot
    await places.refresh()
    expect(service.guests().items[0]?.autostart).toBeNull()
  })

  it('takes a fresh reading when the one it has is older than a few seconds, and only then', async () => {
    const { service, places, source, list, clock } = setup()
    await places.refresh()
    list[0]!.status = 'running'
    expect((await service.guestsNow()).items[0]?.state).toBe('stopped')
    clock.now += 6_000
    expect((await service.guestsNow()).items[0]?.state).toBe('running')
    expect(source.down).toBeUndefined()
  })

  it('gives no guests and a reason when Proxmox cannot be read', async () => {
    const { service, places, source } = setup()
    source.down = true
    await places.refresh()
    const answer = service.guests()
    expect(answer.items).toEqual([])
    expect(answer.failure).toContain('Proxmox did not answer')
  })
})

describe('MachinesService.autostart', () => {
  it('writes Proxmox, reads it back, and leaves what Status expects alone', async () => {
    const { service, places, calls, status } = setup()
    await places.refresh()
    status.syncIntents([{ machine: 'apps', intent: 'on-demand' }])
    const mine = () => JSON.stringify(status.intents().find((m) => m.machine === 'apps'))
    const before = mine()
    const item = await service.autostart('apps', true)
    expect(calls).toEqual(['180:onboot=1'])
    expect(item.autostart).toBe(true)
    expect(mine()).toBe(before)
    expect((await service.autostart('apps', false)).autostart).toBe(false)
  })

  it('does not say it worked when Proxmox still shows the old value', async () => {
    const { service, places, source } = setup()
    await places.refresh()
    source.stuck = true
    await expect(service.autostart('apps', true)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('still shows autostart off'),
    })
  })

  it('passes on a refusal in plain words and an unknown machine as not found', async () => {
    const { service, places, source } = setup()
    await places.refresh()
    source.refuse = true
    await expect(service.autostart('apps', true)).rejects.toMatchObject({ status: 502 })
    await expect(service.autostart('nope', true)).rejects.toMatchObject({ status: 404 })
  })
})

describe('MachinesService.power', () => {
  it('starts, restarts and shuts down a guest through Proxmox, as the Projects page does', async () => {
    const { service, places, calls, status } = setup()
    await places.refresh()
    await service.power('apps', 'on', false)
    await service.power('ominull-hub', 'restart', false)
    expect(calls).toEqual(['180:start', '150:reboot'])
    expect(status.intents().find((m) => m.machine === 'ominull-hub')?.stoppedAt).toBe(T0)
  })

  it('shuts down cleanly, and records an always-on machine as stopped by the owner so it does not page', async () => {
    const { service, places, calls, status } = setup()
    await places.refresh()
    await service.power('ominull-hub', 'off', false)
    expect(calls).toEqual(['150:shutdown'])
    expect(status.intents().find((m) => m.machine === 'ominull-hub')?.stoppedAt).toBe(T0)
  })

  it('shows power in progress on the guest', async () => {
    const { service, places } = setup()
    await places.refresh()
    const item = await service.power('apps', 'on', false)
    expect(item).toMatchObject({ busy: 'start', state: 'starting' })
  })

  it('refuses a machine the registry says is not powered from the page, and one Proxmox does not list', async () => {
    const { service, places } = setup()
    await places.refresh()
    await expect(service.power('aico', 'off', false)).rejects.toMatchObject({ status: 422 })
    await expect(service.power('nope', 'on', false)).rejects.toMatchObject({ status: 404 })
  })

  it('leaves on and off of a session host to Tether, which ends its sessions first', async () => {
    const { service, places, calls, request } = setup({ state: 'connected', sessions: 2 })
    await places.refresh()
    await service.power('agent-work', 'off', true)
    expect(request).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/power'),
      { action: 'off', force: true },
      expect.anything(),
    )
    expect(calls).toEqual([])
  })

  it('shows a failed shutdown on the guest and force-offs it through Proxmox', async () => {
    const { service, places, calls, source } = setup()
    source.outcome = { state: 'failed', reason: 'VM quit/powerdown failed - got timeout' }
    await places.refresh()
    await service.power('ominull-hub', 'off', false)
    await places.refresh()
    await places.refresh()
    expect(service.guests().items.find((i) => i.machine === 'ominull-hub')).toMatchObject({
      state: 'running',
      busy: null,
      failed: { action: 'shutdown', reason: 'VM quit/powerdown failed - got timeout' },
    })
    await service.power('ominull-hub', 'stop', false)
    expect(calls).toEqual(['150:shutdown', '150:stop'])
  })

  it('warns before a restart takes sessions down, and restarts through Proxmox once forced', async () => {
    const { service, places, calls, list } = setup({ state: 'connected', sessions: 2 })
    list[3]!.status = 'running'
    await places.refresh()
    await expect(service.power('agent-work', 'restart', false)).rejects.toMatchObject({
      status: 409,
      message: '2 sessions running on agent-work',
    })
    expect(calls).toEqual([])
    await service.power('agent-work', 'restart', true)
    expect(calls).toEqual(['200:reboot'])
  })
})

describe('machine routes', () => {
  let server: Server
  let base: string
  let ctx: ReturnType<typeof setup>
  beforeEach(async () => {
    ctx = setup()
    await ctx.places.refresh()
    const router = new Router()
    registerMachineRoutes(router, ctx.service)
    server = createServer((req, res) => {
      void router.handle(req, res, new URL(req.url || '/', 'http://localhost'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    base = `http://127.0.0.1:${address.port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('serves the guests', async () => {
    const answer = (await (await fetch(`${base}/api/machines/guests`)).json()) as {
      items: unknown[]
      failure: string | null
    }
    expect(answer.items).toHaveLength(4)
    expect(answer.failure).toBeNull()
  })

  it('toggles autostart and answers with what Proxmox now says', async () => {
    const res = await post('/api/machines/apps/autostart', { on: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ machine: 'apps', autostart: true })
    expect((await post('/api/machines/apps/autostart', { on: 'yes' })).status).toBe(400)
  })

  it('powers a machine and refuses a bad action or name', async () => {
    expect((await post('/api/machines/apps/power', { action: 'on' })).status).toBe(200)
    expect(ctx.calls).toContain('180:start')
    expect((await post('/api/machines/apps/power', { action: 'kill' })).status).toBe(400)
    expect((await post('/api/machines/apps/power', {})).status).toBe(400)
    expect((await post('/api/machines/nope/power', { action: 'on' })).status).toBe(404)
  })
})

describe('session copies', () => {
  it('reads what this machine holds through aico shift, and says so when it can’t', async () => {
    let calls = 0
    let answer = '{"machines":[{"machine":"aico","at":1,"sessions":[]}]}'
    let clock = T0
    const router = new Router()
    registerMachineRoutes(
      router,
      {} as MachinesService,
      async () => 'ok',
      () => clock,
      async () => {
        calls++
        return answer
      },
    )
    const server = createServer((req, res) => {
      void router.handle(req, res, new URL(req.url ?? '/', 'http://x'))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/machines/session-copies`
    expect(await (await fetch(url)).json()).toEqual({
      machines: [{ machine: 'aico', at: 1, sessions: [] }],
    })
    await fetch(url)
    expect(calls).toBe(1)
    clock += 3_600_000
    answer = 'not json'
    expect((await fetch(url)).status).toBe(502)
    server.close()
  })
})

describe('services', () => {
  it('reads and restarts through aico power, and refuses a name that is no service', async () => {
    const calls: string[][] = []
    const router = new Router()
    registerMachineRoutes(
      router,
      {} as MachinesService,
      async (args) => {
        calls.push(args)
        return args[0] === 'units' ? '[{"machine":"aico","units":[]}]' : 'ok'
      },
      () => T0,
    )
    const server = createServer((req, res) => {
      void router.handle(req, res, new URL(req.url ?? '/', 'http://x'))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/machines`
    const post = (unit: string) =>
      fetch(`${base}/davion-sidarli/restart-service`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unit }),
      })
    expect(await (await fetch(`${base}/services`)).json()).toEqual({
      machines: [{ machine: 'aico', units: [] }],
    })
    await fetch(`${base}/services`)
    expect(calls).toHaveLength(1)
    expect((await post('tether@default.service')).status).toBe(200)
    expect(calls[1]).toEqual(['restart', 'tether@default.service', '--on', 'davion-sidarli'])
    expect((await post('../../x; rm')).status).toBe(422)
    await new Promise((done) => server.close(done))
  })
})
