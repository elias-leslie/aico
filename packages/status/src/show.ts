// Reading rows: the late and unknown rules, filters, sort and rollup. Pure
// functions over stored rows, so the replay fixtures run them without a DB.
//
// Late: a row past its next_run shows "late since next_run" (whatever it last
// reported, except off: stopped on purpose is never late).
// Run by a job: a row with run_by waits on that job. While the job is off (paused), or hasn't had its
// turn since the row fell due, the row isn't late; the job's own row goes late if the job stops.
// Off on purpose: every other row of a machine whose own machine row says off (or that is meant to
// be off) shows "off" since then, with machine_off set and its last report kept. Off is not a
// problem: it sorts and counts with the healthy rows, on the screen, the badge and `aico status`.
// Unknown: every other row of a machine whose own machine row is late, and of a machine with no
// machine row at all (shown_since null). Unknown is a problem; it is never counted as ok.
// Back: when a machine reports again after being off or late, a row that fell
// due while it was away and hasn't reported since shows unknown (why 'back',
// since the machine's return) instead of late, for at most one of its own
// intervals (next_run - last_run); a report ends that, and so does the interval.
// Settling: a row can't report while its on-demand machine is shutting down or booting, or while
// the server reading it has just started. Until that has had time to pass (`Settling`), a row past
// due shows unknown (why 'back') instead of late: the machine's power or a restart is not a problem.
//
// The badge (owner rule, 2026-11-03, shown as off since 2026-11-06): rows of a machine turned off on
// purpose are not problems, so they are out of the badge count and alerts like any off row. Rows
// waiting after their machine's return show unknown but are left out of the badge too: nothing is
// known wrong yet.

import {
  countShown,
  isProblem,
  matchesSearch,
  PROBLEMS,
  type Problem,
  SHOWN,
  type Shown,
  SORTS,
  STATUS_ORDER,
  type StatusSort,
} from '@aico/shared/status-order'
import { showsBack } from './intent'
import { type Major, needsOwner } from './major'
import type { Kind, StatusRow } from './row'

/** A row as stored: what the writer posted and when the server took it. */
export interface StoredRow {
  row: StatusRow
  /** Epoch ms. */
  updatedAt: number
  /** Machine rows: when the machine reported again after being off or late (epoch ms). */
  backAt?: number
  /** Rows saying off: since when they have said so (epoch ms). */
  offAt?: number
}

// Shown states, problems and sorts are shared with the Status page (@aico/shared/status-order).
export { PROBLEMS, type Problem, SHOWN, type Shown, SORTS }

/**
 * Why a row shows unknown: its machine row went late or there is none; or its machine is back and
 * the row, due while it was away, hasn't reported since.
 */
export type UnknownWhy = 'late' | 'missing' | 'back'

export interface ShownRow extends StatusRow {
  updated_at: string
  shown: Shown
  /** For late, unknown and off rows: since when (RFC 3339 UTC). */
  shown_since: string | null
  /** Shown off because its machine is off on purpose (not because the row itself says off). */
  machine_off?: true
  /** Only on unknown rows. */
  unknown_why?: UnknownWhy
}

export type Sort = StatusSort

export interface Filter {
  state?: readonly Shown[]
  kind?: readonly Kind[]
  machine?: readonly string[]
  project?: readonly string[]
  /** Case-insensitive text in the id, what, meaning, kind, machine or project. */
  search?: string
  sort?: Sort
}

export interface Rollup {
  problems: number
  /** ok and off rows. */
  healthy: number
  counts: Record<Shown, number>
}

/** What the tray badge and the phone read: all rows, whatever the filter. */
export interface Summary {
  /** Problems that count: unknown rows waiting after their machine's return are left out. */
  problems: number
  /** The worst shown state among the counted problems, or null. */
  worst: Shown | null
  /** Counted problems by state. */
  counts: Record<Problem, number>
  /** Rows shown unknown but not counted: waiting after their machine's return. */
  quiet: number
  /** Of the counted problems, those the owner must act on (major.ts needsOwner): the panel opens for these only. */
  needs: number
  healthy: number
  /** The first three counted problems, worst first. */
  top: ShownRow[]
}

/** A row that has stayed failed or late past its class's window (major.ts). */
export interface Sustained {
  row: ShownRow
  major: Major
  /** Epoch ms since the row has been in this state. */
  since: number
}

export interface StatusView {
  generated_at: string
  /** Of the rows that pass the filter. */
  rollup: Rollup
  /** Of every row, for the badge. */
  summary: Summary
  rows: ShownRow[]
}

const iso = (ms: number) => new Date(ms).toISOString()

/** When a row is due to report again, or null (off rows and rows without next_run never are). */
function dueAt(stored: StoredRow): number | null {
  const { state, next_run } = stored.row
  return state === 'off' || next_run === undefined ? null : Date.parse(next_run)
}

/** How long past its next run a row may still report before it shows late: a scheduler starts a
 * due run on its next tick and the run reports when it ends, so a row seconds past due is on time. */
export const LATE_GRACE_MS = 2 * 60_000

/** Since when a row is overdue (its next run, once the grace has passed), or null. */
function lateSince(stored: StoredRow, now: number): number | null {
  const due = dueAt(stored)
  return due !== null && now > due + LATE_GRACE_MS ? due : null
}

/** Whether a row's job excuses it from being late at `now` (the header's "run by a job"). */
function waitsOnJob(stored: StoredRow, byId: ReadonlyMap<string, StoredRow>, now: number): boolean {
  const job = stored.row.run_by === undefined ? undefined : byId.get(stored.row.run_by)
  if (!job) return false
  if (job.row.state === 'off') return true
  if (job.row.next_run === undefined) return false
  const due = dueAt(stored)
  const ran = job.row.last_run ? Date.parse(job.row.last_run) : 0
  return due !== null && ran < due && lateSince(job, now) === null
}

/** How long a row past due waits for its machine or this server to settle. Overridable (config.ts). */
export const SETTLE_MS = 10 * 60_000

/** What may hold a row past due back from late at `now` (StatusStore.settling). */
export interface Settling {
  ms: number
  /** On-demand machines the hypervisor last read as on, with since when (epoch ms). */
  onDemand?: ReadonlyMap<string, number>
  /** Until when this server has only just started: its writers haven't had a turn (epoch ms). */
  until?: number
}

/** When a row due at `due` may show late, given what is settling; 0 when nothing holds it. */
function settledAt(machine: string, due: number, settling?: Settling): number {
  if (!settling) return 0
  const on = settling.onDemand?.get(machine)
  return Math.max(settling.until ?? 0, on === undefined ? 0 : Math.max(due, on) + settling.ms)
}

/** A row's own interval: from its last run (else its last report) to its next. */
function interval(stored: StoredRow, due: number): number {
  const last = stored.row.last_run ? Date.parse(stored.row.last_run) : stored.updatedAt
  return Math.max(0, due - last)
}

/**
 * Applies the late, unknown and back rules at `now`. `expectedOff` (machine to epoch ms, from
 * StatusStore.expectedOff) names machines meant to be off (parked, on demand and not in use, or
 * shut down by the owner): they show off since then, and so do their rows, until the machine
 * reports again after that moment.
 */
export function show(
  rows: readonly StoredRow[],
  now: number,
  expectedOff: ReadonlyMap<string, number> = new Map(),
  settling?: Settling,
): ShownRow[] {
  // Per machine with a machine row: since when it says the machine is not reporting (late or
  // off), else null; and when it last came back.
  const silent = new Map<string, { since: number; why: UnknownWhy | 'off' } | null>()
  const back = new Map<string, number>()
  for (const stored of rows) {
    if (stored.row.kind !== 'machine') continue
    const off = stored.row.state === 'off'
    const since = off ? (stored.offAt ?? stored.updatedAt) : lateSince(stored, now)
    const settlingNow =
      !off && since !== null && now < settledAt(stored.row.machine, since, settling)
    silent.set(
      stored.row.machine,
      since === null ? null : { since, why: off ? 'off' : settlingNow ? 'back' : 'late' },
    )
    if (stored.backAt !== undefined) back.set(stored.row.machine, stored.backAt)
  }
  const stopped = new Map<string, number>()
  for (const [machine, at] of expectedOff) {
    if (rows.some((r) => r.row.machine === machine && showsBack(r.row) && r.updatedAt > at))
      continue
    // A planned outage can be dated slightly ahead (see StatusStore.planOutage): never "since" the future.
    const since = Math.min(at, now)
    stopped.set(machine, since)
    silent.set(machine, { since, why: 'off' })
  }
  const byId = new Map(rows.map((stored) => [stored.row.id, stored]))
  return rows.map((stored) => {
    const base = { ...stored.row, updated_at: iso(stored.updatedAt) }
    const stoppedAt = stopped.get(stored.row.machine)
    if (stoppedAt !== undefined && stored.row.kind === 'machine')
      return { ...base, shown: 'off', shown_since: iso(stoppedAt) }
    if (stored.row.kind !== 'machine') {
      const machine = silent.get(stored.row.machine)
      if (machine === undefined)
        return { ...base, shown: 'unknown', shown_since: null, unknown_why: 'missing' }
      if (machine !== null && machine.why === 'off')
        return {
          ...base,
          shown: 'off',
          shown_since: iso(machine.since),
          machine_off: true as const,
        }
      if (machine !== null)
        return {
          ...base,
          shown: 'unknown',
          shown_since: iso(machine.since),
          unknown_why: machine.why as UnknownWhy,
        }
    }
    if (stored.row.state === 'off')
      return { ...base, shown: 'off', shown_since: iso(stored.offAt ?? stored.updatedAt) }
    const due = waitsOnJob(stored, byId, now) ? null : lateSince(stored, now)
    if (due === null) return { ...base, shown: stored.row.state, shown_since: null }
    const settled = settledAt(stored.row.machine, due, settling)
    if (now < settled)
      return { ...base, shown: 'unknown', shown_since: iso(due), unknown_why: 'back' }
    // Due while its machine was away and silent since it came back: unknown until it reports,
    // for at most one of its own intervals from the machine's return; late after that.
    const backAt = back.get(stored.row.machine)
    if (
      stored.row.kind !== 'machine' &&
      backAt !== undefined &&
      due <= backAt &&
      stored.updatedAt < backAt
    ) {
      const graceEnd = backAt + interval(stored, due)
      if (now > graceEnd) return { ...base, shown: 'late', shown_since: iso(graceEnd) }
      return { ...base, shown: 'unknown', shown_since: iso(backAt), unknown_why: 'back' }
    }
    return { ...base, shown: 'late', shown_since: iso(Math.max(due, settled)) }
  })
}

/** The rows that pass `filter`, in its sort order (problems first by default). */
function select(rows: readonly ShownRow[], filter: Filter = {}): ShownRow[] {
  const kept = rows.filter((row) => {
    if (filter.state?.length && !filter.state.includes(row.shown)) return false
    if (filter.kind?.length && !filter.kind.includes(row.kind)) return false
    if (filter.machine?.length && !filter.machine.includes(row.machine)) return false
    if (filter.project?.length && !(row.project && filter.project.includes(row.project)))
      return false
    return matchesSearch(row, filter.search)
  })
  return kept.sort(STATUS_ORDER[filter.sort ?? 'problems'])
}

function rollup(rows: readonly ShownRow[]): Rollup {
  // One count everywhere: a row left out of the badge is left out of the rollup too.
  const counts = countShown(rows.filter((row) => !QUIET.includes(row.unknown_why)))
  const problems = PROBLEMS.reduce((sum, state) => sum + counts[state], 0)
  return { problems, healthy: rows.filter((row) => !isProblem(row.shown)).length, counts }
}

/** Unknown rows the badge leaves out: their machine just came back. */
const QUIET: readonly (UnknownWhy | undefined)[] = ['back']

/** Whether a row counts toward the badge and alerts: a problem not left out as quiet. */
export function counted(row: ShownRow): boolean {
  return isProblem(row.shown) && !QUIET.includes(row.unknown_why)
}

/** Where a pile of problems comes from: the machine most of them are on, when that is a crowd. */
export interface Concentration {
  machine: string
  count: number
}

/** A machine with at least this many counted problems, and at least half of all of them, is named. */
export const CROWD_MIN = 5

/**
 * The machine behind a jump in the count (a guest that is down takes all its rows with it), or null.
 * The badge, `aico status` and the morning digest say it, so a count that leaps is explained where
 * it is read.
 */
export function concentration(rows: readonly ShownRow[]): Concentration | null {
  const counts = new Map<string, number>()
  for (const row of rows.filter(counted))
    counts.set(row.machine, (counts.get(row.machine) ?? 0) + 1)
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return top && top[1] >= CROWD_MIN && top[1] * 2 >= total
    ? { machine: top[0], count: top[1] }
    : null
}

export function summary(rows: readonly ShownRow[]): Summary {
  const problems = select(rows.filter(counted))
  const counts = Object.fromEntries(PROBLEMS.map((state) => [state, 0])) as Summary['counts']
  for (const row of problems) counts[row.shown as Problem] += 1
  const quiet = rows.filter(
    (row) => row.shown === 'unknown' && QUIET.includes(row.unknown_why),
  ).length
  return {
    problems: problems.length,
    worst: PROBLEMS.find((state) => counts[state] > 0) ?? null,
    counts,
    quiet,
    needs: problems.filter(needsOwner).length,
    healthy: rows.filter((row) => !isProblem(row.shown)).length,
    top: problems.slice(0, 3),
  }
}

/** `select`, `rollup` and `summary` together: what the API and the CLI read. */
export function view(
  rows: readonly StoredRow[],
  now: number,
  filter: Filter = {},
  expectedOff?: ReadonlyMap<string, number>,
  settling?: Settling,
): StatusView {
  const shown = show(rows, now, expectedOff, settling)
  const selected = select(shown, filter)
  return {
    generated_at: iso(now),
    rollup: rollup(selected),
    summary: summary(shown),
    rows: selected,
  }
}
