// Idle power-off (docs/plans/remote-hosts.md "Power"): a powered-on host that has a hosts.json
// `sleep` command and no sessions for its `idleOffMin` minutes (15 by default, 0 never) is powered
// off by that command, the same way the Hosts panel's Power off does. Never a host with a session
// (not ended), a pending wake, a placement booking, or a create, wake or update in progress. How
// the host came up does not matter: one started by hand is powered off the same way. Each
// power-off is logged and written to Status; the row goes when the host is up again.

import { AICO_WEB_DEFAULT_URL } from '../config'
import type { IdleFacts } from './hub'

export interface IdleOffDeps {
  hostNames(): string[]
  idleFacts(name: string): IdleFacts | null
  /** Open placement reservations (`placing` or `held`) on the host. */
  booked(host: string): boolean
  /** Power the host off unless sessions run there (HostAdmin.power with `force` off). */
  powerOff(host: string): Promise<unknown>
  /** Write or clear the host's Status row. */
  status(host: string, row: IdleOffRow | null): Promise<void>
  log(message: string): void
  now(): number
}

export interface IdleOffRow {
  id: string
  what: string
  kind: 'vm'
  machine: string
  state: 'off'
  meaning: string
  last_run: string
}

/** How often hosts are looked at. */
const IDLE_CHECK_MS = 30_000

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export class IdleOff {
  /** When each idle host was first seen idle (ms). */
  private readonly idleSince = new Map<string, number>()
  /** Live hosts whose old power-off row was cleared since they came up. */
  private readonly cleared = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly deps: IdleOffDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), IDLE_CHECK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One look at every host; at most one runs at a time. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const name of this.deps.hostNames()) await this.look(name)
    } finally {
      this.running = false
    }
  }

  private async look(name: string): Promise<void> {
    const facts = this.deps.idleFacts(name)
    if (!facts?.live) {
      this.idleSince.delete(name)
      this.cleared.delete(name)
      return
    }
    // The host is up: a row from its last power-off no longer holds (also after a hub restart).
    if (!this.cleared.has(name)) {
      try {
        await this.deps.status(name, null)
        this.cleared.add(name)
      } catch {
        // Tried again at the next look.
      }
    }
    const minutes = facts.entry.idleOffMin
    if (!facts.entry.sleep || minutes <= 0) {
      this.idleSince.delete(name)
      return
    }
    if (facts.sessions > 0 || facts.wakes > 0 || facts.busy || this.deps.booked(name)) {
      this.idleSince.delete(name)
      return
    }
    const now = this.deps.now()
    const since = this.idleSince.get(name) ?? now
    this.idleSince.set(name, since)
    if (now - since < minutes * 60_000) return
    this.idleSince.delete(name)
    try {
      await this.deps.powerOff(name)
    } catch (error) {
      // Busy after all, or the command failed: the clock starts over, so it is tried again after
      // another idle period, not on every look.
      this.idleSince.set(name, this.deps.now())
      this.deps.log(`${name}: idle power-off did not happen: ${(error as Error).message}`)
      return
    }
    this.deps.log(`${name}: powered off after ${minutes} minutes with no sessions`)
    const at = this.deps.now()
    await this.deps
      .status(name, {
        id: `tether/idle-off/${name}`,
        what: `${name} powered off when idle`,
        kind: 'vm',
        machine: name,
        state: 'off',
        meaning: `Tether powered ${name} off at ${clock(at)} after ${minutes} minutes with no sessions. It starts again when a session is created there or from Hosts.`,
        last_run: new Date(at).toISOString(),
      })
      .catch((error: Error) => {
        this.deps.log(`${name}: could not write its Status row: ${error.message}`)
      })
  }
}

/** Status over aico-web's loopback API, as the fleet link writes its rows. */
export function statusWriter(env: NodeJS.ProcessEnv): IdleOffDeps['status'] {
  const base = (env.AICO_WEB_URL?.trim() || AICO_WEB_DEFAULT_URL).replace(/\/+$/, '')
  return async (host, row) => {
    const response = row
      ? await fetch(`${base}/api/status/rows`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([row]),
          signal: AbortSignal.timeout(10_000),
        })
      : await fetch(`${base}/api/status/rows?id=${encodeURIComponent(`tether/idle-off/${host}`)}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(10_000),
        })
    if (!response.ok && response.status !== 404)
      throw new Error(`Status answered ${response.status}`)
  }
}
