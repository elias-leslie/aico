// Where projects run, and the power buttons: a poller reads Proxmox (through the fleet's SSH
// alias) for each place's power state, and the page's start / shutdown / restart go through the
// same route. Shutdown and restart are clean (guest shutdown / reboot); there is no hard stop.
// Every reading is also fed to Status as the machine's observed power (setObservedPower), so an
// on-demand machine is expected off while stopped and on while running, however it was started
// or shut down (aico vm, Proxmox, the page). A shutdown from the page also records the machine
// as owner-stopped first, so an always-on one shows off instead of paging (show.ts).

import type { Guest, GuestAction } from '@aico/fleet/power'
import type { StatusStore } from '@aico/status'
import type { Place } from '@aico/tasks'
import { HttpError } from './tether'

const PLACE_STATES = ['running', 'stopped', 'down', 'starting', 'unknown'] as const
export type PlaceState = (typeof PLACE_STATES)[number]
export const POWER_ACTIONS = ['start', 'shutdown', 'restart'] as const
export type PowerAction = (typeof POWER_ACTIONS)[number]

/** The Proxmox guest action behind each button. */
const GUEST_ACTION: Record<PowerAction, GuestAction> = {
  start: 'start',
  shutdown: 'shutdown',
  restart: 'reboot',
}

export interface PlaceView extends Place {
  state: PlaceState
  /** When it reached this state (RFC 3339), when known. */
  since: string | null
  /** When the state was last read (RFC 3339); null before the first reading. */
  asOf: string | null
  /** A power action the page started and Proxmox has not finished, else null. */
  busy: PowerAction | null
  /** Why the state is unknown, when it is. */
  note?: string
}

export interface GuestSource {
  list(): Promise<Guest[]>
  act(guest: Guest, action: GuestAction): Promise<void>
  /** Writes Proxmox's start-at-boot setting. */
  setOnboot(guest: Guest, on: boolean): Promise<void>
}

type Marks = Pick<
  StatusStore,
  'expectedOff' | 'intents' | 'syncIntents' | 'setObservedPower' | 'markStopped' | 'rows' | 'read'
>

export interface PlacesOptions {
  /** Proxmox access; null when no Proxmox alias is configured. */
  guests: GuestSource | null
  status: Marks
  /** Every place of every open project, from the registry (so intents and machines are current). */
  declared: () => readonly Place[]
  /** This server's machine id (a `host` place with this machine is running). */
  machine: string
  pollMs: number
  busyMs: number
  now?: () => number
}

interface Pending {
  action: PowerAction
  at: number
}

const iso = (ms: number) => new Date(ms).toISOString()

export class Places {
  private snapshot: Map<number, Guest> | null = null
  private readAt: number | null = null
  private failure: string | null = null
  private readonly pending = new Map<number, Pending>()
  private timer: NodeJS.Timeout | null = null
  private reading: Promise<void> | null = null
  private readonly now: () => number
  private readonly startedAt: number

  constructor(private readonly options: PlacesOptions) {
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.options.pollMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Reads Proxmox now. A failure keeps the last reading's time and makes every guest unknown. */
  refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => {
      this.reading = null
    })
    return this.reading
  }

  /** Reads Proxmox now unless it was read within `ms`: what a page asks for is at most that old. */
  refreshIfOlder(ms: number): Promise<void> {
    return this.readAt !== null && this.now() - this.readAt < ms
      ? Promise.resolve()
      : this.refresh()
  }

  private async read(): Promise<void> {
    const { guests } = this.options
    this.syncIntents()
    if (!guests) {
      this.failure = 'No Proxmox access is set up on this machine.'
      return
    }
    const at = this.now()
    try {
      const list = await guests.list()
      this.snapshot = new Map(list.map((guest) => [guest.vmid, guest]))
      this.readAt = at
      this.failure = null
      this.observe(at)
      this.settle(at)
    } catch (error) {
      this.failure = `Proxmox did not answer (${(error as Error).message.split('\n')[0]}).`
    }
  }

  /** Feeds each declared guest's power state into Status; a guest Proxmox does not list or reports oddly keeps its last reading. */
  private observe(at: number): void {
    const done = new Set<string>()
    for (const place of this.options.declared()) {
      if (!place.machine || place.kind === 'host' || place.id === undefined) continue
      if (done.has(place.machine)) continue
      const guest = this.snapshot?.get(place.id)
      if (guest?.status !== 'running' && guest?.status !== 'stopped') continue
      done.add(place.machine)
      this.options.status.setObservedPower(
        place.machine,
        guest.status === 'running',
        at,
        guest.status === 'running' ? at - guest.uptime * 1000 : at,
      )
    }
  }

  /** Ends finished power actions and owner-stopped marks that a later start has made moot. */
  private settle(at: number): void {
    for (const [vmid, pending] of this.pending) {
      const guest = this.snapshot?.get(vmid)
      const rebooted = guest !== undefined && guest.uptime < (at - pending.at) / 1000
      const done =
        pending.action === 'shutdown'
          ? guest?.status === 'stopped'
          : pending.action === 'start'
            ? guest?.status === 'running'
            : rebooted && guest?.status === 'running'
      if (done || at - pending.at > this.options.busyMs) this.pending.delete(vmid)
    }
    const rows = this.options.status.rows()
    for (const m of this.options.status.intents()) {
      if (m.stoppedAt === null) continue
      const guest = [...(this.snapshot?.values() ?? [])].find(
        (g) => this.machineOf(g) === m.machine,
      )
      if (!guest || guest.status !== 'running' || guest.uptime >= (at - m.stoppedAt) / 1000)
        continue
      // Started again after the owner stopped it. Its own machine row ends the mark when it has
      // one (show.ts); a machine with no row of its own would stay off forever, so end it here.
      const reports = rows.some((r) => r.row.kind === 'machine' && r.row.machine === m.machine)
      if (!reports) this.options.status.markStopped(m.machine, null)
    }
  }

  /** Copies each place's declared intent into Status, so alerts and the badge can use it. */
  private syncIntents(): void {
    const machines = new Map<string, Place['intent']>()
    for (const place of this.options.declared())
      if (place.machine && !machines.has(place.machine)) machines.set(place.machine, place.intent)
    this.options.status.syncIntents([...machines].map(([machine, intent]) => ({ machine, intent })))
  }

  /** The machine of a guest, from the declared places. */
  private machineOf(guest: Guest): string | undefined {
    return this.options.declared().find((place) => place.kind !== 'host' && place.id === guest.vmid)
      ?.machine
  }

  /** Whether the place is meant to be off right now (parked, on demand and unused, or stopped). */
  private expectedOff(place: Place): boolean {
    return place.machine
      ? this.options.status.expectedOff().has(place.machine)
      : place.intent !== 'always'
  }

  /** What the last Proxmox reading listed (templates left out), when it was read, and why it
   * could not be read; `guests` is empty then, never a stale list. */
  guestList(): { guests: Guest[]; asOf: string | null; failure: string | null } {
    const asOf = this.readAt === null ? null : iso(this.readAt)
    const failure = this.failure ?? (this.snapshot ? null : 'Not read yet.')
    if (failure || !this.snapshot) return { guests: [], asOf, failure }
    return { guests: [...this.snapshot.values()].filter((guest) => !guest.template), asOf, failure }
  }

  /**
   * Turns Proxmox's start-at-boot on or off for one guest, then reads it back: the answer is what
   * Proxmox now says, not what was asked. It does not touch the guest's declared intent (Status's
   * "meant to be on" is the registry's; this is only whether Proxmox starts it at boot).
   */
  async setAutostart(vmid: number, on: boolean): Promise<Guest> {
    const { guests } = this.options
    if (!guests) throw new HttpError(503, 'No Proxmox access is set up on this machine.')
    await this.refresh()
    const guest = this.snapshot?.get(vmid)
    if (this.failure || !guest)
      throw new HttpError(503, this.failure ?? 'Proxmox does not list this guest.')
    try {
      await guests.setOnboot(guest, on)
    } catch (error) {
      throw new HttpError(
        502,
        `${guest.name}: Proxmox refused autostart ${on ? 'on' : 'off'} (${(error as Error).message.split('\n')[0]}).`,
      )
    }
    // A reading that was already under way predates the write.
    await this.reading
    await this.refresh()
    const now = this.snapshot?.get(vmid)
    if (this.failure || !now)
      throw new HttpError(503, `${guest.name}: set, but Proxmox did not answer when read back.`)
    if (now.onboot !== on)
      throw new HttpError(
        502,
        `${guest.name}: Proxmox still shows autostart ${now.onboot ? 'on' : 'off'}.`,
      )
    return now
  }

  view(place: Place): PlaceView {
    const base = { ...place, busy: null as PowerAction | null }
    if (place.kind === 'host') return this.hostView(base)
    const asOf = this.readAt === null ? null : iso(this.readAt)
    const pending = place.id === undefined ? undefined : this.pending.get(place.id)
    const busy = pending?.action ?? null
    if (this.failure)
      return { ...base, state: 'unknown', since: null, asOf, busy, note: this.failure }
    const guest = place.id === undefined ? undefined : this.snapshot?.get(place.id)
    if (!guest)
      return {
        ...base,
        state: 'unknown',
        since: null,
        asOf,
        busy,
        note: this.snapshot ? 'Proxmox does not list this guest.' : 'Not read yet.',
      }
    const readAt = this.readAt as number
    if (guest.status === 'running') {
      const since = iso(readAt - guest.uptime * 1000)
      return { ...base, state: busy === 'start' ? 'starting' : 'running', since, asOf, busy }
    }
    if (guest.status === 'stopped') {
      if (busy === 'start') return { ...base, state: 'starting', since: null, asOf, busy }
      const offSince = place.machine
        ? this.options.status.expectedOff().get(place.machine)
        : undefined
      return this.expectedOff(place)
        ? {
            ...base,
            state: 'stopped',
            since: offSince === undefined ? null : iso(offSince),
            asOf,
            busy,
          }
        : { ...base, state: 'down', since: null, asOf, busy }
    }
    return {
      ...base,
      state: 'unknown',
      since: null,
      asOf,
      busy,
      note: `Proxmox says ${guest.status}.`,
    }
  }

  private hostView(base: Place & { busy: PowerAction | null }): PlaceView {
    const at = iso(this.now())
    if (base.machine === undefined || base.machine === this.options.machine)
      return { ...base, state: 'running', since: iso(this.startedAt), asOf: at }
    const row = this.options.status
      .read({ machine: [base.machine], kind: ['machine'] })
      .rows.find((r) => r.kind === 'machine' && r.machine === base.machine)
    if (!row)
      return {
        ...base,
        state: 'unknown',
        since: null,
        asOf: at,
        note: 'No report from this machine.',
      }
    const state: PlaceState =
      row.shown === 'ok' || row.shown === 'warn'
        ? 'running'
        : row.shown === 'off'
          ? 'stopped'
          : row.shown === 'late' || row.shown === 'failed'
            ? 'down'
            : 'unknown'
    return { ...base, state, since: row.shown_since, asOf: at }
  }

  /**
   * Runs one power action on a place. Refuses places the page does not power, and actions that
   * make no sense for the state ("restart" of a stopped guest). Shutting down a guest that is
   * already stopped only records that the owner meant it.
   */
  async power(place: Place, action: PowerAction): Promise<PlaceView> {
    const { guests, status } = this.options
    if (!place.power || place.kind === 'host' || place.id === undefined)
      throw new HttpError(422, `${place.label} is not powered from the page.`)
    if (!guests) throw new HttpError(503, 'No Proxmox access is set up on this machine.')
    await this.refresh()
    const guest = this.snapshot?.get(place.id)
    if (this.failure || !guest)
      throw new HttpError(
        503,
        `${place.label}: ${this.failure ?? 'Proxmox does not list this guest.'}`,
      )
    if (this.pending.has(place.id))
      throw new HttpError(
        409,
        `${place.label} is already ${this.pending.get(place.id)?.action === 'start' ? 'starting' : 'changing power'}.`,
      )
    const running = guest.status === 'running'
    const at = this.now()
    if (action === 'start' && running) return this.view(place)
    if (action === 'restart' && !running)
      throw new HttpError(409, `${place.label} is not running; start it instead.`)
    const machine = place.machine
    const before = machine ? status.intents().find((m) => m.machine === machine) : undefined
    const mark = (): void => {
      if (!machine) return
      // The owner's move is recorded first: the rows of a machine that goes quiet must never
      // page. Starting an always-on place ends its stop; a place that is not always on needs no
      // mark for a start (the poller sees it run); a restart of an always-on place is a short
      // stop its next report ends.
      if (action === 'shutdown') status.markStopped(machine, at)
      else if (action === 'start') status.markStopped(machine, null)
      else if (place.intent === 'always') status.markStopped(machine, at)
    }
    if (action === 'shutdown' && !running) {
      mark()
      return this.view(place)
    }
    mark()
    try {
      await guests.act(guest, GUEST_ACTION[action])
    } catch (error) {
      if (machine && before) status.markStopped(machine, before.stoppedAt)
      throw new HttpError(
        502,
        `${place.label}: Proxmox refused ${action} (${(error as Error).message.split('\n')[0]}).`,
      )
    }
    this.pending.set(place.id, { action, at })
    void this.refresh()
    return this.view(place)
  }
}

/**
 * One state for a project from its places: running only when every place runs; a place the
 * owner did not stop that is not running is down; unknown when anything is unknown.
 */
export function runStateOf(places: readonly PlaceView[]): PlaceState | null {
  if (places.length === 0) return null
  const states = places.map((place) => place.state)
  if (states.every((state) => state === 'running')) return 'running'
  if (states.includes('unknown')) return 'unknown'
  if (states.includes('down')) return 'down'
  if (states.includes('starting')) return 'starting'
  return 'stopped'
}
