// Reading rows: the late and unknown rules, filters, sort and rollup. Pure
// functions over stored rows, so the replay fixtures run them without a DB.
//
// Late: a row past its next_run shows "late since next_run" (whatever it last
// reported, except off: stopped on purpose is never late).
// Unknown: every other row of a machine whose own machine row is late or off
// shows "unknown" since then, and of a machine with no machine row at all
// (shown_since null). Unknown is a problem; it is never counted as ok.
// Back: when a machine reports again after being off or late, a row that fell
// due while it was away and hasn't reported since shows unknown (why 'back',
// since the machine's return) instead of late, for at most one of its own
// intervals (next_run - last_run); a report ends that, and so does the interval.
//
// The badge (owner rule, 2026-11-03): rows that show unknown only because their machine row says
// off (turned off on purpose) stay on the screen as unknown but out of the badge count and alerts.
// Rows waiting after their machine's return are left out the same way: nothing is known wrong yet.

import type { Kind, StatusRow } from './row'

/** A row as stored: what the writer posted and when the server took it. */
export interface StoredRow {
  row: StatusRow
  /** Epoch ms. */
  updatedAt: number
  /** Machine rows: when the machine reported again after being off or late (epoch ms). */
  backAt?: number
}

/** What a reader sees: the writer's state, or late / unknown. */
export const SHOWN = ['failed', 'late', 'unknown', 'warn', 'ok', 'off'] as const
export type Shown = (typeof SHOWN)[number]

/** Shown states that are problems (listed first); the rest fold into the healthy count. */
export const PROBLEMS: readonly Shown[] = ['failed', 'late', 'unknown', 'warn']
export type Problem = 'failed' | 'late' | 'unknown' | 'warn'

/**
 * Why a row shows unknown: its machine row says off, went late, or there is none; or its machine
 * is back and the row, due while it was away, hasn't reported since.
 */
export type UnknownWhy = 'off' | 'late' | 'missing' | 'back'

export interface ShownRow extends StatusRow {
  updated_at: string
  shown: Shown
  /** For late and unknown: since when (RFC 3339 UTC). */
  shown_since: string | null
  /** Only on unknown rows. */
  unknown_why?: UnknownWhy
}

export const SORTS = ['problems', 'what', 'updated', 'next'] as const
export type Sort = (typeof SORTS)[number]

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
  /** Problems that count: quiet unknown rows (machine off on purpose, or just back) are left out. */
  problems: number
  /** The worst shown state among the counted problems, or null. */
  worst: Shown | null
  /** Counted problems by state. */
  counts: Record<Problem, number>
  /** Rows shown unknown but not counted: on a machine turned off on purpose, or waiting after its return. */
  quiet: number
  healthy: number
  /** The first three counted problems, worst first. */
  top: ShownRow[]
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

/** Since when a row is overdue, or null. */
function lateSince(stored: StoredRow, now: number): number | null {
  const due = dueAt(stored)
  return due !== null && now > due ? due : null
}

/** A row's own interval: from its last run (else its last report) to its next. */
function interval(stored: StoredRow, due: number): number {
  const last = stored.row.last_run ? Date.parse(stored.row.last_run) : stored.updatedAt
  return Math.max(0, due - last)
}

/** Applies the late, unknown and back rules at `now`. */
export function show(rows: readonly StoredRow[], now: number): ShownRow[] {
  // Per machine with a machine row: since when it says the machine is not reporting (late or
  // off), else null; and when it last came back.
  const silent = new Map<string, { since: number; why: UnknownWhy } | null>()
  const back = new Map<string, number>()
  for (const stored of rows) {
    if (stored.row.kind !== 'machine') continue
    const off = stored.row.state === 'off'
    const since = off ? stored.updatedAt : lateSince(stored, now)
    silent.set(stored.row.machine, since === null ? null : { since, why: off ? 'off' : 'late' })
    if (stored.backAt !== undefined) back.set(stored.row.machine, stored.backAt)
  }
  return rows.map((stored) => {
    const base = { ...stored.row, updated_at: iso(stored.updatedAt) }
    if (stored.row.kind !== 'machine') {
      const machine = silent.get(stored.row.machine)
      if (machine === undefined)
        return { ...base, shown: 'unknown', shown_since: null, unknown_why: 'missing' }
      if (machine !== null)
        return {
          ...base,
          shown: 'unknown',
          shown_since: iso(machine.since),
          unknown_why: machine.why,
        }
    }
    const due = lateSince(stored, now)
    if (due === null) return { ...base, shown: stored.row.state, shown_since: null }
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
    return { ...base, shown: 'late', shown_since: iso(due) }
  })
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byWhat = (a: ShownRow, b: ShownRow) => byCodeUnit(a.what, b.what) || byCodeUnit(a.id, b.id)
const rank = (row: ShownRow) => SHOWN.indexOf(row.shown)
const nextOf = (row: ShownRow) =>
  row.next_run ? Date.parse(row.next_run) : Number.POSITIVE_INFINITY

const ORDER: Record<Sort, (a: ShownRow, b: ShownRow) => number> = {
  problems: (a, b) => rank(a) - rank(b) || byWhat(a, b),
  what: byWhat,
  updated: (a, b) => byCodeUnit(b.updated_at, a.updated_at) || byWhat(a, b),
  next: (a, b) => nextOf(a) - nextOf(b) || byWhat(a, b),
}

/** The rows that pass `filter`, in its sort order (problems first by default). */
export function select(rows: readonly ShownRow[], filter: Filter = {}): ShownRow[] {
  const needle = filter.search?.trim().toLowerCase()
  const kept = rows.filter((row) => {
    if (filter.state?.length && !filter.state.includes(row.shown)) return false
    if (filter.kind?.length && !filter.kind.includes(row.kind)) return false
    if (filter.machine?.length && !filter.machine.includes(row.machine)) return false
    if (filter.project?.length && !(row.project && filter.project.includes(row.project)))
      return false
    if (needle) {
      const haystack = [row.id, row.what, row.meaning, row.kind, row.machine, row.project ?? '']
      if (!haystack.some((field) => field.toLowerCase().includes(needle))) return false
    }
    return true
  })
  return kept.sort(ORDER[filter.sort ?? 'problems'])
}

export function rollup(rows: readonly ShownRow[]): Rollup {
  const counts = Object.fromEntries(SHOWN.map((state) => [state, 0])) as Record<Shown, number>
  for (const row of rows) counts[row.shown] += 1
  const problems = PROBLEMS.reduce((sum, state) => sum + counts[state], 0)
  return { problems, healthy: rows.length - problems, counts }
}

/** Unknown rows the badge leaves out: their machine is off on purpose, or just came back. */
const QUIET: readonly (UnknownWhy | undefined)[] = ['off', 'back']

/** Whether a row counts toward the badge and alerts: a problem not left out as quiet. */
export function counted(row: ShownRow): boolean {
  return PROBLEMS.includes(row.shown) && !QUIET.includes(row.unknown_why)
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
    worst: problems[0]?.shown ?? null,
    counts,
    quiet,
    healthy: rows.filter((row) => !PROBLEMS.includes(row.shown)).length,
    top: problems.slice(0, 3),
  }
}

/** `select`, `rollup` and `summary` together: what the API and the CLI read. */
export function view(rows: readonly StoredRow[], now: number, filter: Filter = {}): StatusView {
  const shown = show(rows, now)
  const selected = select(shown, filter)
  return {
    generated_at: iso(now),
    rollup: rollup(selected),
    summary: summary(shown),
    rows: selected,
  }
}
