// Where a machine is meant to be: running always, started only when needed, or parked. The
// registry declares it per place (packages/tasks/src/projects.ts, Place.intent); the Projects
// service copies it here (StatusStore.syncIntents) so Status can tell an expected-off machine
// from one that died. Alerts, the badge, Projects and backups all read the same answer.

export const INTENTS = ['always', 'on-demand', 'off'] as const
export type Intent = (typeof INTENTS)[number]

/**
 * What the owner expects of a machine: `always` is on, `off` is off, `on-demand` is on only
 * while someone started it for use. A machine the owner shut down is off whatever its intent.
 */
export function expectedState(intent: Intent, inUse: boolean): 'on' | 'off' {
  return intent === 'always' || (intent === 'on-demand' && inUse) ? 'on' : 'off'
}

/** One machine's declared intent and what the owner did with it since. Epoch milliseconds. */
export interface MachineIntent {
  machine: string
  intent: Intent
  /** When this expectation began (the intent was first recorded). */
  since: number
  /** The owner shut it down on purpose. */
  stoppedAt: number | null
  /** The owner started an on-demand machine for use. */
  usedSince: number | null
}

/** Since when a machine is expected to be off, or null when it is expected on. */
export function expectedOffSince(m: MachineIntent): number | null {
  if (m.stoppedAt !== null) return m.stoppedAt
  return expectedState(m.intent, m.usedSince !== null) === 'off' ? m.since : null
}
