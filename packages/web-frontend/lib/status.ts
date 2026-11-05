// The Status page's data and words. GET /api/status serves the rows with the late and unknown
// rules applied (packages/status show.ts); the page filters, sorts and counts them here the same
// way, so the rollup chips can count every state while one is picked.

export const SHOWN = ['failed', 'late', 'unknown', 'warn', 'ok', 'off'] as const
export type Shown = (typeof SHOWN)[number]
export const PROBLEMS = ['failed', 'late', 'unknown', 'warn'] as const
export type Problem = (typeof PROBLEMS)[number]
export const KINDS = [
  'check',
  'job',
  'backup',
  'service',
  'vm',
  'machine',
  'link',
  'grant',
  'repo',
] as const
export type ActionKind = 'run' | 'log' | 'detail' | 'look'

export interface StatusAction {
  kind: ActionKind
  ref: string
}

export interface StatusRow {
  id: string
  what: string
  kind: string
  machine: string
  project?: string
  state: 'ok' | 'warn' | 'failed' | 'off'
  meaning: string
  last_run?: string
  next_run?: string
  actions?: StatusAction[]
  updated_at: string
  shown: Shown
  shown_since: string | null
  /** Its machine is off, went late, has no machine row, or is back and this hasn't reported since. */
  unknown_why?: 'off' | 'late' | 'missing' | 'back'
}

export interface StatusSummary {
  problems: number
  worst: Shown | null
  counts: Record<Problem, number>
  quiet: number
  healthy: number
  top: StatusRow[]
}

export interface StatusView {
  generated_at: string
  summary: StatusSummary
  rows: StatusRow[]
  /** The machine aico-web runs on: run and log refs work only for its rows. */
  machine?: string
  /** Rows whose run ref is going now (one run per row). */
  running?: string[]
}

export const WORD: Record<Shown | 'running', string> = {
  failed: 'Failed',
  late: 'Late',
  unknown: 'Unknown',
  warn: 'Warning',
  ok: 'OK',
  off: 'Off',
  running: 'Running',
}

export const SORTS = [
  ['problems', 'Problems first'],
  ['what', 'Name'],
  ['updated', 'Last report'],
  ['next', 'Next due'],
] as const
export type Sort = (typeof SORTS)[number][0]

export interface StatusFilter {
  states: Shown[]
  kind: string
  machine: string
  project: string
  search: string
  sort: Sort
}

export const NO_FILTER: StatusFilter = {
  states: [],
  kind: '',
  machine: '',
  project: '',
  search: '',
  sort: 'problems',
}

export const isProblem = (shown: Shown) =>
  (PROBLEMS as readonly string[]).includes(shown)

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null)
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byWhat = (a: StatusRow, b: StatusRow) =>
  byText(a.what, b.what) || byText(a.id, b.id)
const rank = (row: StatusRow) => SHOWN.indexOf(row.shown)
const ORDER: Record<Sort, (a: StatusRow, b: StatusRow) => number> = {
  problems: (a, b) => rank(a) - rank(b) || byWhat(a, b),
  what: byWhat,
  updated: (a, b) => byText(b.updated_at, a.updated_at) || byWhat(a, b),
  next: (a, b) =>
    (time(a.next_run) ?? Number.POSITIVE_INFINITY) -
      (time(b.next_run) ?? Number.POSITIVE_INFINITY) || byWhat(a, b),
}

/** Whether a row passes the filter; `withState` false skips the state chips (the rollup's scope). */
export function matches(
  row: StatusRow,
  filter: StatusFilter,
  withState = true,
): boolean {
  if (withState && filter.states.length && !filter.states.includes(row.shown))
    return false
  if (filter.kind && row.kind !== filter.kind) return false
  if (filter.machine && row.machine !== filter.machine) return false
  if (filter.project && row.project !== filter.project) return false
  const needle = filter.search.trim().toLowerCase()
  if (
    needle &&
    ![
      row.id,
      row.what,
      row.meaning,
      row.kind,
      row.machine,
      row.project ?? '',
    ].some((field) => field.toLowerCase().includes(needle))
  )
    return false
  return true
}

export function sortRows(rows: readonly StatusRow[], sort: Sort): StatusRow[] {
  return [...rows].sort(ORDER[sort])
}

export function rollup(rows: readonly StatusRow[]): Record<Shown, number> {
  const counts = Object.fromEntries(SHOWN.map((state) => [state, 0])) as Record<
    Shown,
    number
  >
  for (const row of rows) counts[row.shown] += 1
  return counts
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

/** A rollup chip's word: "2 late", "1 warning", "3 warnings". */
export function stateCount(state: Shown, n: number): string {
  if (state === 'warn') return plural(n, 'warning')
  if (state === 'ok') return `${n} OK`
  return `${n} ${state}`
}

/** "No problems" or "4 problems: 1 failed, 3 unknown" (the badge's words). */
export function summaryLine(summary: StatusSummary): string {
  if (!summary.problems) return 'No problems'
  const parts = PROBLEMS.filter((state) => summary.counts[state]).map((state) =>
    stateCount(state, summary.counts[state]),
  )
  return `${plural(summary.problems, 'problem')}: ${parts.join(', ')}`
}

/** Why a late or unknown row is so, said before its last report. */
export function reason(row: StatusRow): string {
  if (row.shown === 'late') return 'Didn’t report when due.'
  if (row.shown !== 'unknown') return ''
  if (row.unknown_why === 'off')
    return `${row.machine} is off, so this can’t report.`
  if (row.unknown_why === 'late') return `${row.machine} stopped reporting.`
  if (row.unknown_why === 'back')
    return `${row.machine} is back; this hasn’t reported since.`
  return `Aico hasn’t heard from ${row.machine} itself.`
}

// -- Time: 12-hour local times, as the rest of the web app shows them.

const dayKey = (ms: number) => new Date(ms).toDateString()
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
const monthDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const weekday = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })
const DAY = 86_400_000

/** "4:30 AM", "yesterday 4:51 PM", "tomorrow 2:40 AM", "Nov 1, 2:10 AM". */
export function at(ms: number | null, now: number): string {
  if (ms === null || Number.isNaN(ms)) return '—'
  const day = dayKey(ms)
  if (day === dayKey(now)) return clock(ms)
  if (day === dayKey(now - DAY)) return `yesterday ${clock(ms)}`
  if (day === dayKey(now + DAY)) return `tomorrow ${clock(ms)}`
  return `${monthDay(ms)}, ${clock(ms)}`
}

/** The phone's short form: "4:30 AM", "Mon 4:51 PM", "Oct 28". */
function atShort(ms: number | null, now: number): string {
  if (ms === null || Number.isNaN(ms)) return '—'
  if (dayKey(ms) === dayKey(now)) return clock(ms)
  return Math.abs(now - ms) < 6 * DAY
    ? `${weekday(ms)} ${clock(ms)}`
    : monthDay(ms)
}

export function ago(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return minutes < 48 * 60
    ? `${Math.round(minutes / 60)} h ago`
    : `${Math.floor(minutes / 1440)} days ago`
}

export interface When {
  /** The line that leads: "Late since 4:30 AM", "Ran 8:17 PM". */
  lead: string
  /** The second line, or null. */
  sub: string | null
  /** The phone's short form. */
  short: string
  tone: 'late' | 'strong' | 'plain'
}

export function when(row: StatusRow, now: number): When {
  const since = time(row.shown_since)
  const updated = Date.parse(row.updated_at)
  const last = time(row.last_run)
  const next = time(row.next_run)
  if (row.shown === 'late')
    return {
      lead: `Late since ${at(since, now)}`,
      sub: `Last ran ${at(last, now)}`,
      short: `since ${atShort(since, now)}`,
      tone: 'late',
    }
  if (row.shown === 'unknown')
    return {
      lead:
        since === null
          ? `No word from ${row.machine}`
          : `Unknown since ${at(since, now)}`,
      sub: `Last report ${at(updated, now)}`,
      short: since === null ? 'no word' : `since ${atShort(since, now)}`,
      tone: 'strong',
    }
  if (row.shown === 'off')
    return {
      lead: `Off since ${at(updated, now)}`,
      sub: null,
      short: `since ${atShort(updated, now)}`,
      tone: 'plain',
    }
  return {
    lead: `Ran ${at(last ?? updated, now)}`,
    sub: next === null ? null : `Next ${at(next, now)}`,
    short: `ran ${atShort(last ?? updated, now)}`,
    tone: 'plain',
  }
}

// -- Actions

export type ButtonKind = ActionKind | 'hosts'
export const ACTION_LABEL: Record<ButtonKind, string> = {
  look: 'Look into it',
  run: 'Run now',
  log: 'Log',
  detail: 'Detail',
  hosts: 'Hosts',
}
const ACTION_ORDER: ButtonKind[] = ['hosts', 'look', 'run', 'log', 'detail']

export interface RowButton {
  kind: ButtonKind
  ref: string
  /** Why it can't be used now (shown as its tooltip), or null. */
  disabled: string | null
}

export interface ActionContext {
  /** The machine aico-web runs on; run and log work only for its rows. */
  here: string | undefined
  /** Machines the Hosts sheet lists. */
  hosts: ReadonlySet<string>
}

/** A detail ref the page can open: a page of its own (`/status/...`). None exists yet. */
const DETAIL_PAGES: readonly string[] = []

/**
 * The buttons a row offers, in order, and the one that helps most. An action with nothing behind
 * it is left out: run and log only for rows of this machine (and not the OmniNull hub's), detail
 * only where its page exists, Hosts only for a machine the Hosts sheet knows.
 */
export function rowButtons(
  row: StatusRow,
  context: ActionContext,
): { buttons: RowButton[]; primary: ButtonKind | null } {
  const local = row.machine === context.here && !row.id.startsWith('ominull')
  // Unknown because its machine isn't reporting (not just back and waiting on this row).
  const silent = row.shown === 'unknown' && row.unknown_why !== 'back'
  const buttons: RowButton[] = []
  for (const action of row.actions ?? []) {
    if ((action.kind === 'run' || action.kind === 'log') && !local) continue
    if (action.kind === 'detail' && !DETAIL_PAGES.includes(action.ref)) continue
    if (action.kind === 'look') continue
    buttons.push({
      kind: action.kind,
      ref: action.ref,
      disabled:
        action.kind === 'run' && silent
          ? `${row.machine} isn’t reporting, so it can’t run now`
          : null,
    })
  }
  // Look into it starts a session about any problem; the row's look ref, if any, names where.
  if (isProblem(row.shown))
    buttons.push({
      kind: 'look',
      ref: row.actions?.find((action) => action.kind === 'look')?.ref ?? '',
      disabled: null,
    })
  if (silent && context.hosts.has(row.machine))
    buttons.push({ kind: 'hosts', ref: row.machine, disabled: null })
  buttons.sort(
    (a, b) => ACTION_ORDER.indexOf(a.kind) - ACTION_ORDER.indexOf(b.kind),
  )
  const has = (kind: ButtonKind) =>
    buttons.some((button) => button.kind === kind && !button.disabled)
  const primary: ButtonKind | null =
    row.shown === 'unknown'
      ? has('hosts')
        ? 'hosts'
        : !silent && has('run')
          ? 'run'
          : null
      : row.shown === 'late'
        ? has('run')
          ? 'run'
          : 'look'
        : row.shown === 'failed' || row.shown === 'warn'
          ? 'look'
          : null
  return { buttons, primary }
}

/** The project a Look into it session starts in: the look ref's project, the row's, or `fallback`. */
export function lookProject(
  row: StatusRow,
  projects: readonly { id: string; root_path: string | null }[],
  fallback: string,
): string {
  const ref = row.actions?.find((action) => action.kind === 'look')?.ref
  if (ref?.startsWith('/')) {
    const owner = projects.find(
      (project) =>
        project.root_path &&
        (ref === project.root_path || ref.startsWith(`${project.root_path}/`)),
    )
    if (owner) return owner.id
  }
  if (row.project && projects.some((project) => project.id === row.project))
    return row.project
  return fallback
}

/** The first message of a Look into it session. */
export function lookMessage(row: StatusRow): string {
  const why = reason(row)
  return `Status row ${row.id} is ${WORD[row.shown].toLowerCase()}: ${why ? `${why} ` : ''}${row.meaning} Find out why and fix it.`
}

/** A machine that went late: its rows show unknown since then (the partial state). */
export function silentMachines(
  rows: readonly StatusRow[],
): { machine: string; since: string | null; rows: number }[] {
  return rows
    .filter((row) => row.kind === 'machine' && row.shown === 'late')
    .map((row) => ({
      machine: row.machine,
      since: row.shown_since,
      rows: rows.filter(
        (other) => other.machine === row.machine && other.kind !== 'machine',
      ).length,
    }))
}
