// Where a machine is meant to be: running always, started only when needed, or parked. The
// registry declares it per place (packages/tasks/src/projects.ts, Place.intent); the Projects
// service copies it here (StatusStore.syncIntents) so Status can tell an expected-off machine
// from one that died. The power state itself is observed (StatusStore.setObservedPower, fed by
// the Proxmox poller), never inferred from which button was pressed: an on-demand machine is
// expected on while it runs and off while it is stopped, however it was started or shut down.
// Alerts, the badge, Projects and backups all read the same answer.

export const INTENTS = ['always', 'on-demand', 'off'] as const
export type Intent = (typeof INTENTS)[number]

/**
 * What is expected of a machine: `always` is on, `off` is off, `on-demand` is on exactly while
 * it runs (whoever started it). A machine the owner shut down is off whatever its intent.
 */
export function expectedState(intent: Intent, running: boolean): 'on' | 'off' {
  return intent === 'always' || (intent === 'on-demand' && running) ? 'on' : 'off'
}

/** One machine's declared intent and what the owner did with it since. Epoch milliseconds. */
export interface MachineIntent {
  machine: string
  intent: Intent
  /** When this expectation began (the intent was first recorded). */
  since: number
  /** The owner shut it down on purpose. */
  stoppedAt: number | null
  /** Last observed power state (from the hypervisor); null before the first reading. */
  power: 'on' | 'off' | null
  /** When the machine reached that state, as far as the observer could tell. */
  powerSince: number | null
  /** When the power state was last read; kept while the hypervisor is unreachable. */
  powerAt: number | null
}

/** Since when a machine is expected to be off, or null when it is expected on. */
export function expectedOffSince(m: MachineIntent): number | null {
  if (m.stoppedAt !== null) return m.stoppedAt
  if (expectedState(m.intent, m.power === 'on') === 'on') return null
  // An on-demand machine is off since it was seen stopping; before that was ever read, since
  // the expectation began.
  return m.intent === 'on-demand' && m.power === 'off' ? (m.powerSince ?? m.since) : m.since
}

/**
 * Whether a machine row, posted after a machine was marked off, shows the machine is back: it
 * reports itself (not off), or a link to it says it is connected. A link that only says it is
 * disconnected (written by the machine watching it) is not the machine reporting.
 */
export function showsBack(row: { id: string; kind: string; state: string }): boolean {
  if (row.kind !== 'machine' || row.state === 'off') return false
  return !row.id.startsWith('fleet/') || row.state === 'ok'
}
