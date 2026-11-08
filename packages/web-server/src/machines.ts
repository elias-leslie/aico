// The Machines page's Proxmox side: each guest's power, autostart (Proxmox's `onboot`), size and
// the projects that run on it, and the buttons that act on them.
//   GET  /api/machines/guests                  the guests and when Proxmox was read (or why not)
//   POST /api/machines/:machine/power          {action: on | off | restart | stop, force?}  (stop = force off, after a clean shutdown failed)
//   POST /api/machines/:machine/autostart      {on: true | false}
//   GET  /api/machines/services                each full Aico's services and their state (aico power units)
//   POST /api/machines/:machine/restart-service {unit}
//   GET  /api/machines/session-copies          what was running on the other machines when last heard from (aico shift list)
// Power goes through Places (Proxmox, the same path as the Projects page), except on / off of a
// machine Tether links to as a session host: Tether ends its sessions first and follows the start
// (powering on, connecting, checking services), which Places cannot. A guest is found by the
// machine a project declares for it, else by its Proxmox name (agent-work, neri-hunters).

import { spawn } from 'node:child_process'
import type { Guest } from '@aico/fleet/power'
import type { Place, Project } from '@aico/tasks'
import { hostPower, type TetherClient } from '@aico/tether-client'
import { hostCall } from './hosts'
import { objectBody, type Router } from './http'
import type { PlaceState, Places, PlaceView, PowerFailure } from './places'
import { HttpError } from './tether'

export interface MachineGuest {
  /** The machine name Status and Tether know it by. */
  machine: string
  vmid: number
  kind: 'vm' | 'ct'
  state: PlaceState
  since: string | null
  busy: PlaceView['busy']
  /** The last clean shutdown or restart Proxmox ran and failed, with Proxmox's reason; null otherwise. */
  failed: PowerFailure | null
  /** Why the state is unknown. */
  note?: string
  /** Proxmox's start-at-boot; null when it could not be read. */
  autostart: boolean | null
  /** Where the registry says it is meant to be; null for a guest no project declares. */
  intent: Place['intent'] | null
  /** Whether the page may power it (a declared place can say no). */
  powerable: boolean
  cpus: number | null
  memoryMb: number | null
  projects: { id: string; name: string }[]
}

type Registry = { list(options?: { all?: boolean }): Project[] }

const MIB = 1024 * 1024
/** How old a reading may be when the page asks. */
const FRESH_MS = 5000
const kindOf = (guest: Guest): 'vm' | 'ct' => (guest.type === 'qemu' ? 'vm' : 'ct')

export class MachinesService {
  constructor(
    private readonly places: Places,
    private readonly registry: Registry,
    private readonly tether: TetherClient,
  ) {}

  /** Every declared place that is a Proxmox guest, with the project that declares it. */
  private declared(): { place: Place; project: Project }[] {
    return this.registry
      .list()
      .flatMap((project) =>
        project.runtime
          .filter((place) => place.kind !== 'host' && place.id !== undefined)
          .map((place) => ({ place, project })),
      )
  }

  private placeFor(guest: Guest, declared = this.declared()): Place {
    return (
      declared.find((d) => d.place.id === guest.vmid)?.place ?? {
        kind: kindOf(guest),
        id: guest.vmid,
        node: guest.node,
        label: guest.name,
        power: true,
        intent: 'on-demand',
      }
    )
  }

  /** The guests as Proxmox says now: a reading older than a few seconds is taken again first. */
  async guestsNow() {
    await this.places.refreshIfOlder(FRESH_MS)
    return this.guests()
  }

  guests(): { items: MachineGuest[]; asOf: string | null; failure: string | null } {
    const { guests, asOf, failure } = this.places.guestList()
    const declared = this.declared()
    const items = guests.map((guest): MachineGuest => {
      const mine = declared.filter((d) => d.place.id === guest.vmid)
      const place = this.placeFor(guest, declared)
      const view = this.places.view(place)
      return {
        machine: place.machine ?? guest.name,
        vmid: guest.vmid,
        kind: kindOf(guest),
        state: view.state,
        since: view.since,
        busy: view.busy,
        failed: view.failed,
        ...(view.note ? { note: view.note } : {}),
        autostart: guest.onboot ?? null,
        intent: mine.length ? place.intent : null,
        powerable: place.power,
        cpus: guest.maxcpu || null,
        memoryMb: guest.maxmem ? Math.round(guest.maxmem / MIB) : null,
        projects: [...new Map(mine.map((d) => [d.project.id, d.project.name])).entries()].map(
          ([id, name]) => ({ id, name }),
        ),
      }
    })
    return { items, asOf, failure }
  }

  /** The guest a machine name stands for, with its place. */
  private find(machine: string): { guest: Guest; place: Place } {
    const { guests } = this.places.guestList()
    const declared = this.declared()
    const id = declared.find((d) => d.place.machine === machine)?.place.id
    const guest = guests.find((g) => (id !== undefined ? g.vmid === id : g.name === machine))
    if (!guest) throw new HttpError(404, `Proxmox does not list a machine called ${machine}.`)
    return { guest, place: this.placeFor(guest, declared) }
  }

  private item(machine: string): MachineGuest {
    const item = this.guests().items.find((candidate) => candidate.machine === machine)
    if (!item) throw new HttpError(404, `Proxmox does not list a machine called ${machine}.`)
    return item
  }

  async power(machine: string, action: 'on' | 'off' | 'restart' | 'stop', force: boolean) {
    await this.places.refresh()
    const { place } = this.find(machine)
    if (!place.power) throw new HttpError(422, `${machine} is not powered from the page.`)
    const link = await this.tether
      .hosts()
      .then((hosts) => hosts.find((host) => host.name === machine))
      .catch(() => undefined)
    if (link && link.canSleep !== false && action !== 'restart' && action !== 'stop') {
      // Tether's own on / off: it ends the sessions (409 until forced) and follows the start.
      await hostCall(() => hostPower(this.tether, machine, action, force))
      void this.places.refresh()
    } else {
      if (
        (action === 'restart' || action === 'stop') &&
        link?.state === 'connected' &&
        (link.sessions ?? 0) > 0 &&
        !force
      )
        throw new HttpError(
          409,
          `${link.sessions} session${link.sessions === 1 ? '' : 's'} running on ${machine}`,
        )
      await this.places.power(
        place,
        action === 'on' ? 'start' : action === 'off' ? 'shutdown' : action,
      )
    }
    return this.item(machine)
  }

  async autostart(machine: string, on: boolean): Promise<MachineGuest> {
    await this.places.refresh()
    await this.places.setAutostart(this.find(machine).guest.vmid, on)
    return this.item(machine)
  }
}

const MACHINE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const UNIT = /^[A-Za-z0-9][A-Za-z0-9@._-]*\.service$/
/** The page polls and a reading asks the other machine too. */
const SERVICES_FRESH_MS = 4000

export type PowerCommand = (args: string[]) => Promise<string>

/** The installed `aico power`, so the page and the CLI do the same thing. */
const powerCommand: PowerCommand = (args) => aicoCommand('power', args)

/** The installed `aico shift list`: what this machine holds of the other machines' sessions. */
const copiesCommand: PowerCommand = () => aicoCommand('shift', ['list', '--json'])

const aicoCommand = (verb: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('aico', [verb, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (data) => {
      out += String(data)
    })
    child.stderr.on('data', (data) => {
      err = (err + String(data)).slice(-2000)
    })
    child.on('error', () => reject(new HttpError(503, 'Couldn’t ask this machine.')))
    child.on('close', (code) => {
      if (code === 0) return resolve(out.trim())
      const said = err
        .trim()
        .split('\n')
        .pop()
        ?.replace(/^aico \w+:\s*/, '')
      reject(new HttpError(code === 2 ? 422 : 502, said || 'The machine didn’t answer.'))
    })
  })

export function registerMachineRoutes(
  router: Router,
  service: MachinesService,
  power: PowerCommand = powerCommand,
  now: () => number = Date.now,
  copies: PowerCommand = copiesCommand,
) {
  const machineName = (value: string) => {
    if (!MACHINE.test(value)) throw new HttpError(422, 'Unknown machine')
    return value
  }
  router.on('GET', '/api/machines/guests', () => service.guestsNow())
  let services: { value: unknown; at: number } | null = null
  router.on('GET', '/api/machines/services', async () => {
    if (services && now() - services.at <= SERVICES_FRESH_MS) return services.value
    let machines: unknown
    try {
      machines = JSON.parse(await power(['units', '--json']))
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'The services came back unreadable.')
    }
    services = { value: { machines }, at: now() }
    return services.value
  })
  let held: { value: unknown; at: number } | null = null
  router.on('GET', '/api/machines/session-copies', async () => {
    if (held && now() - held.at <= SERVICES_FRESH_MS) return held.value
    let value: unknown
    try {
      value = JSON.parse(await copies([]))
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'The session copies came back unreadable.')
    }
    held = { value, at: now() }
    return value
  })
  router.on('POST', '/api/machines/:machine/restart-service', async (ctx) => {
    const machine = machineName(ctx.params.machine)
    const unit = objectBody(await ctx.body()).unit
    if (typeof unit !== 'string' || !UNIT.test(unit)) throw new HttpError(422, 'Unknown service')
    const message = await power(['restart', unit, '--on', machine])
    services = null
    return { message }
  })
  router.on('POST', '/api/machines/:machine/power', async (ctx) => {
    const machine = machineName(ctx.params.machine)
    const body = objectBody(await ctx.body())
    if (
      body.action !== 'on' &&
      body.action !== 'off' &&
      body.action !== 'restart' &&
      body.action !== 'stop'
    )
      throw new HttpError(400, 'action must be on, off, restart or stop')
    return service.power(machine, body.action, body.force === true)
  })
  router.on('POST', '/api/machines/:machine/autostart', async (ctx) => {
    const machine = machineName(ctx.params.machine)
    const body = objectBody(await ctx.body())
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false')
    return service.autostart(machine, body.on)
  })
}
