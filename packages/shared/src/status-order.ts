// What a Status problem costs if it is left alone, so the screen, the badge and `aico status`
// list lost work and security first, service trouble next and resource pressure last. One table:
// the first rule a row matches gives its tier; a row no rule names is service trouble.

export const TIERS = [
  { id: 'lost', label: 'Lost work' },
  { id: 'security', label: 'Security' },
  { id: 'service', label: 'Service' },
  { id: 'resource', label: 'Speed and space' },
] as const

export type Tier = (typeof TIERS)[number]['id']

interface Rule {
  tier: Tier
  /** Row kinds the rule covers. */
  kinds?: readonly string[]
  /** A pattern for the row id. Either field matching is enough. */
  id?: RegExp
}

const RULES: readonly Rule[] = [
  // Unsaved, unbacked-up or damaged work, and sessions or jobs killed for memory.
  {
    tier: 'lost',
    kinds: ['backup', 'repo'],
    id: /(^|\/)check-(backups|memory|disk-tests)$|^jobs\/backups-|(^|\/)job-scrub-/,
  },
  // Sudo, login, tripwire, grant and detection problems.
  {
    tier: 'security',
    kinds: ['grant'],
    id: /(^|\/)check-(sudo|security|tripwire|ominull-lock|router-drift)$|^ominull\.(detection|anomalies|compliance)\b/,
  },
  // Slow, full, hot or used up: nothing is lost yet.
  {
    tier: 'resource',
    id: /(^|\/)check-(perf|storage|thermal|trends|usage)$|^usage\/|(^|\/)job-(space-guard|housekeeping)$/,
  },
]

/** The tier of a Status row: lost work, security, service (the default) or resource pressure. */
export function tierOf(row: { id: string; kind: string }): Tier {
  const rule = RULES.find(
    (candidate) => candidate.kinds?.includes(row.kind) || candidate.id?.test(row.id),
  )
  return rule?.tier ?? 'service'
}

const ORDER = TIERS.map((tier) => tier.id)

/** Comparison for tiers: negative when `a` costs more than `b`. */
export function byTier(a: { id: string; kind: string }, b: { id: string; kind: string }): number {
  return ORDER.indexOf(tierOf(a)) - ORDER.indexOf(tierOf(b))
}

export function tierLabel(tier: Tier): string {
  return TIERS.find((candidate) => candidate.id === tier)?.label ?? tier
}

// -- Shown states, sorts, search and counts: one set of rules for `aico status`, the API and the
// Status page, so the page and the CLI list and count the same rows the same way.

/** What a reader sees: the writer's state, or late / unknown. Problems come first, worst first. */
export const SHOWN = ['failed', 'late', 'unknown', 'warn', 'ok', 'off'] as const
export type Shown = (typeof SHOWN)[number]

/** Shown states that are problems; the rest fold into the healthy count. */
export const PROBLEMS = ['failed', 'late', 'unknown', 'warn'] as const
export type Problem = (typeof PROBLEMS)[number]

export const isProblem = (shown: Shown): shown is Problem =>
  (PROBLEMS as readonly Shown[]).includes(shown)

export const SORTS = ['problems', 'what', 'updated', 'next'] as const
export type StatusSort = (typeof SORTS)[number]

/** The fields of a shown row the sorts, the search and the counts read. */
export interface OrderedRow {
  id: string
  what: string
  kind: string
  meaning: string
  machine: string
  project?: string
  next_run?: string
  /** RFC 3339 UTC, so text order is time order. */
  updated_at: string
  shown: Shown
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byWhat = (a: OrderedRow, b: OrderedRow) =>
  byCodeUnit(a.what, b.what) || byCodeUnit(a.id, b.id)
const rank = (row: OrderedRow) => SHOWN.indexOf(row.shown)
const nextOf = (row: OrderedRow) =>
  row.next_run ? Date.parse(row.next_run) : Number.POSITIVE_INFINITY

/** Problems first, by what each costs (lost work, security, service, resource pressure), then by state. */
const byConsequence = (a: OrderedRow, b: OrderedRow) =>
  Number(!isProblem(a.shown)) - Number(!isProblem(b.shown)) ||
  (isProblem(a.shown) && isProblem(b.shown) ? byTier(a, b) : 0) ||
  rank(a) - rank(b) ||
  byWhat(a, b)

/** Each sort's comparison: problems first, by name, latest report first, soonest due first. */
export const STATUS_ORDER: Record<StatusSort, (a: OrderedRow, b: OrderedRow) => number> = {
  problems: byConsequence,
  what: byWhat,
  updated: (a, b) => byCodeUnit(b.updated_at, a.updated_at) || byWhat(a, b),
  next: (a, b) => nextOf(a) - nextOf(b) || byWhat(a, b),
}

/** Whether a row holds `search` (case-insensitive) in its id, what, meaning, kind, machine or project. */
export function matchesSearch(row: OrderedRow, search: string | undefined): boolean {
  const needle = search?.trim().toLowerCase()
  if (!needle) return true
  return [row.id, row.what, row.meaning, row.kind, row.machine, row.project ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  )
}

/** How many rows show each state. */
export function countShown(rows: readonly { shown: Shown }[]): Record<Shown, number> {
  const counts = Object.fromEntries(SHOWN.map((state) => [state, 0])) as Record<Shown, number>
  for (const row of rows) counts[row.shown] += 1
  return counts
}
