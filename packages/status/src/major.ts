// What Status may interrupt the owner's phone for (owner 2026-11-07): a major issue that has lasted.
// Everything else a row does (a first late or failed run, a project's check, a link, a job that
// catches up) stays on the badge, the screen, the tray and the morning digest. The phone words live
// in packages/notify (phone.ts); this file decides which rows qualify, from the row's own data
// (kind, shown state, its machine's declared intent), and how long it must stay that way.
//
// - data-risk: a backup row failed or late. Sustained: the window is a whole backup period past the
//   first failure, so the retry or next scheduled run has also failed. A row off with its machine
//   (T7 unplugged, guest stopped) never gets here: off is not a problem.
// - outage: a machine row late on a machine expected up (declared always, or not declared at all:
//   the Proxmox host, the hub), or a service row failed. Sustained for a shorter window.

import type { Intent } from './intent'
import type { ShownRow } from './show'

export type Major = 'data-risk' | 'outage'

/** How long a row must stay failed or late before it interrupts, per class (ms). Config, not code. */
export type MajorWindows = Record<Major, number>

/** The class a row belongs to while it is failed or late, or null when it never reaches the phone. */
export function majorOf(row: ShownRow, intents: ReadonlyMap<string, Intent>): Major | null {
  if (row.machine_off || (row.shown !== 'failed' && row.shown !== 'late')) return null
  if (row.kind === 'backup') return 'data-risk'
  if (row.kind === 'service' && row.shown === 'failed') return 'outage'
  if (row.kind === 'machine') {
    const intent = intents.get(row.machine)
    return intent === 'on-demand' || intent === 'off' ? null : 'outage'
  }
  return null
}

/** A row that has stayed failed or late past its class's window. */
export interface Sustained {
  row: ShownRow
  major: Major
  /** Epoch ms since the row has been in this state. */
  since: number
}
