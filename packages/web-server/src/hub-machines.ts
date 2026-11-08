// What the OmniNull hub is told about the fleet, in its push reply: which machines Aico knows, what
// each is meant to do and whether it is up. The hub cannot reach /api/status (loopback), and Aico
// owns inventory, intent and liveness, so the hub keeps no list of its own (OmniNull M5).

import type { Intent, StatusStore } from '@aico/status'
import type { MachineGuest } from './machines'

export interface HubMachine {
  machine: string
  intent: Intent | null
  /** null: Aico cannot tell right now. */
  up: boolean | null
  /** It sends Aico its own machine row (not only a link row a watcher writes), so it counts as a fleet machine that should have an agent. */
  reports: boolean
}

export function hubMachines(guests: readonly MachineGuest[], status: StatusStore): HubMachine[] {
  const intents = new Map(status.intents().map((m) => [m.machine, m.intent]))
  const rows = status.read({ kind: ['machine'] }).rows
  // The hub's own machine: nothing there for it to watch.
  const hub = new Set(rows.filter((r) => r.id.startsWith('ominull.')).map((r) => r.machine))
  const out = new Map<string, HubMachine>()
  for (const row of rows) {
    if (hub.has(row.machine)) continue
    const seen = out.get(row.machine)
    const up = rowSaysUp(row)
    // Several rows for one machine: up if any says so, off only if all do.
    const merged = !seen ? up : seen.up === true || up === true ? true : seen.up === up ? up : null
    out.set(row.machine, {
      machine: row.machine,
      intent: intents.get(row.machine) ?? null,
      up: merged,
      // A fleet/ link row is a watcher's reading of the machine, not the machine reporting.
      reports: (seen?.reports ?? false) || !row.id.startsWith('fleet/'),
    })
  }
  // The hypervisor's reading beats a machine's own reports, when it has one.
  for (const guest of guests) {
    const seen = out.get(guest.machine)
    out.set(guest.machine, {
      machine: guest.machine,
      intent: guest.intent ?? intents.get(guest.machine) ?? null,
      up: guest.state === 'unknown' ? (seen?.up ?? null) : guestSaysUp(guest.state),
      reports: seen?.reports ?? false,
    })
  }
  return [...out.values()].sort((a, b) => a.machine.localeCompare(b.machine))
}

function rowSaysUp(row: { id: string; shown: string }): boolean | null {
  if (row.shown === 'ok') return true
  // A link row in warn is a watcher saying it lost the machine, not the machine reporting.
  if (row.shown === 'warn') return row.id.startsWith('fleet/') ? null : true
  return row.shown === 'off' ? false : null
}

function guestSaysUp(state: MachineGuest['state']): boolean | null {
  if (state === 'running' || state === 'starting') return true
  if (state === 'stopped') return false
  // down: stopped when it was not meant to be. That is not "off": the hub keeps watching it.
  return null
}
