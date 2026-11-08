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
import type { Action } from './row'

export type Major = 'data-risk' | 'outage'

/** The fields of a shown row that decide this (a ShownRow, which this file does not import: show.ts reads it). */
export interface MajorRow {
  kind: string
  machine: string
  shown: string
  machine_off?: true
  actions?: Action[]
}

/** How long a row must stay failed or late before it interrupts, per class (ms). Config, not code. */
export type MajorWindows = Record<Major, number>

/** The class a row belongs to while it is failed or late, or null when it never reaches the phone. */
export function majorOf(row: MajorRow, intents: ReadonlyMap<string, Intent>): Major | null {
  if (row.machine_off || (row.shown !== 'failed' && row.shown !== 'late')) return null
  if (row.kind === 'backup') return 'data-risk'
  if (row.kind === 'service' && row.shown === 'failed') return 'outage'
  if (row.kind === 'machine') {
    const intent = intents.get(row.machine)
    return intent === 'on-demand' || intent === 'off' ? null : 'outage'
  }
  return null
}

/**
 * Whether a row is something the owner must act on, now, for the panel's System section to open by
 * itself: a major row (as above, whatever the window) or a failed row with an owner-only action.
 * Read where the machine intents are already folded into the shown state: an expected-off machine
 * shows off, so a machine row that shows late or failed is one expected up.
 */
export function needsOwner(row: MajorRow): boolean {
  if (row.machine_off) return false
  if (majorOf(row, new Map()) !== null) return true
  return row.shown === 'failed' && (row.actions?.some((a) => a.owner_only === true) ?? false)
}
