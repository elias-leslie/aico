// The Machines page's Proxmox side: each guest's power, autostart (Proxmox's `onboot`), size and
// the projects that run on it, and the buttons that act on them.
//   GET  /api/machines/guests                  the guests and when Proxmox was read (or why not)
//   POST /api/machines/:machine/power          {action: on | off | restart, force?}
//   POST /api/machines/:machine/autostart      {on: true | false}
// Power goes through Places (Proxmox, the same path as the Projects page), except on / off of a
// machine Tether links to as a session host: Tether ends its sessions first and follows the start
// (powering on, connecting, checking services), which Places cannot. A guest is found by the
// machine a project declares for it, else by its Proxmox name (agent-work, neri-hunters).

import type { Guest } from '@aico/fleet/power'
import type { Place, Project } from '@aico/tasks'
import { hostPower, type TetherClient } from '@aico/tether-client'
import { hostCall } from './hosts'
import { objectBody, type Router } from './http'
import type { PlaceState, Places, PowerAction } from './places'
import { HttpError } from './tether'

export interface MachineGuest {
  /** The machine name Status and Tether know it by. */
  machine: string
  vmid: number
  kind: 'vm' | 'ct'
  state: PlaceState
  since: string | null
  busy: PowerAction | null
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

  async power(machine: string, action: 'on' | 'off' | 'restart', force: boolean) {
    await this.places.refresh()
    const { place } = this.find(machine)
    if (!place.power) throw new HttpError(422, `${machine} is not powered from the page.`)
    const link = await this.tether
      .hosts()
      .then((hosts) => hosts.find((host) => host.name === machine))
      .catch(() => undefined)
    if (link && link.canSleep !== false && action !== 'restart') {
      // Tether's own on / off: it ends the sessions (409 until forced) and follows the start.
      await hostCall(() => hostPower(this.tether, machine, action, force))
      void this.places.refresh()
    } else {
      if (action === 'restart' && link?.state === 'connected' && (link.sessions ?? 0) > 0 && !force)
        throw new HttpError(
          409,
          `${link.sessions} session${link.sessions === 1 ? '' : 's'} running on ${machine}`,
        )
      await this.places.power(
        place,
        action === 'on' ? 'start' : action === 'off' ? 'shutdown' : 'restart',
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

export function registerMachineRoutes(router: Router, service: MachinesService) {
  const machineName = (value: string) => {
    if (!MACHINE.test(value)) throw new HttpError(422, 'Unknown machine')
    return value
  }
  router.on('GET', '/api/machines/guests', () => service.guests())
  router.on('POST', '/api/machines/:machine/power', async (ctx) => {
    const machine = machineName(ctx.params.machine)
    const body = objectBody(await ctx.body())
    if (body.action !== 'on' && body.action !== 'off' && body.action !== 'restart')
      throw new HttpError(400, 'action must be on, off or restart')
    return service.power(machine, body.action, body.force === true)
  })
  router.on('POST', '/api/machines/:machine/autostart', async (ctx) => {
    const machine = machineName(ctx.params.machine)
    const body = objectBody(await ctx.body())
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false')
    return service.autostart(machine, body.on)
  })
}
