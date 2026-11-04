// Reading rows: the late and unknown rules, filters, sort and rollup. Pure
// functions over stored rows, so the replay fixtures run them without a DB.
//
// Late: a row past its next_run shows "late since next_run" (whatever it last
// reported, except off: stopped on purpose is never late).
// Unknown: every other row of a machine whose own machine row is late or off
// shows "unknown" since then. Unknown is a problem; it is never counted as ok.

import type { Kind, StatusRow } from './row'

/** A row as stored: what the writer posted and when the server took it. */
export interface StoredRow {
  row: StatusRow
  /** Epoch ms. */
  updatedAt: number
}

/** What a reader sees: the writer's state, or late / unknown. */
export const SHOWN = ['failed', 'late', 'unknown', 'warn', 'ok', 'off'] as const
export type Shown = (typeof SHOWN)[number]

/** Shown states that are problems (listed first); the rest fold into the healthy count. */
export const PROBLEMS: readonly Shown[] = ['failed', 'late', 'unknown', 'warn']

export interface ShownRow extends StatusRow {
  updated_at: string
  shown: Shown
  /** For late and unknown: since when (RFC 3339 UTC). */
  shown_since: string | null
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

export interface StatusView {
  generated_at: string
  /** Of the rows that pass the filter. */
  rollup: Rollup
  rows: ShownRow[]
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Since when a row is overdue, or null. */
function lateSince(stored: StoredRow, now: number): number | null {
  const { state, next_run } = stored.row
  if (state === 'off' || next_run === undefined) return null
  const due = Date.parse(next_run)
  return now > due ? due : null
}

/** Applies the late and unknown rules at `now`. */
export function show(rows: readonly StoredRow[], now: number): ShownRow[] {
  // Since when each machine's own row says it is not reporting (late or off).
  const silent = new Map<string, number>()
  for (const stored of rows) {
    if (stored.row.kind !== 'machine') continue
    const since = stored.row.state === 'off' ? stored.updatedAt : lateSince(stored, now)
    if (since !== null) silent.set(stored.row.machine, since)
  }
  return rows.map((stored) => {
    const base = { ...stored.row, updated_at: iso(stored.updatedAt) }
    const machineSilent = silent.get(stored.row.machine)
    if (stored.row.kind !== 'machine' && machineSilent !== undefined)
      return { ...base, shown: 'unknown', shown_since: iso(machineSilent) }
    const late = lateSince(stored, now)
    if (late !== null) return { ...base, shown: 'late', shown_since: iso(late) }
    return { ...base, shown: stored.row.state, shown_since: null }
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

/** `select` and `rollup` together: what the API and the CLI read. */
export function view(rows: readonly StoredRow[], now: number, filter: Filter = {}): StatusView {
  const selected = select(show(rows, now), filter)
  return { generated_at: iso(now), rollup: rollup(selected), rows: selected }
}
