// Coordinator teams in a session list (the desktop tray and the web list).
// Top level holds coordinators and standalone sessions; a coordinator's lanes
// fold under it. Rows keep the order they arrive in (oldest first); only Needs
// you moves a row, to the top, so working and idle changes never reshuffle the
// list. A team sits in Needs you when it or a lane waits on the owner. Every
// session appears exactly once: a lane whose
// coordinator has ended returns to the top level, marked `orphaned`, and a
// lane that is itself a coordinator folds its own lanes one level further.
//
// Pure and dependency-free: the web app bundles it as `tether/teams`.

/** Attention groups, most urgent first (Aico's tray and web list). */
export type TeamGroup = 'needs-you' | 'finished' | 'working' | 'idle' | 'no-status'

export interface TeamMember {
  id: string
  coordinator: boolean
  /** The coordinator that launched this session, or null. */
  coordinatorId: string | null
  /** The session's own attention group. */
  group: TeamGroup
  /** When its state began (ms), or null. */
  at: number | null
  /** What the member is; a session when absent. A workflow run's steps fold
   * under the run, and the run under the session that launched it. */
  kind?: 'session' | 'run' | 'step'
  /** The line a row with children shows in place of the generated count
   * (a run counts its steps in its own words: `2 done · 1 working`). */
  summary?: string | null
}

export interface TeamRow<T extends TeamMember> {
  item: T
  /** Needs you when a lane waits on the owner, else its own group. */
  group: TeamGroup
  /** Folded lanes, Needs you first, then in arrival order. */
  children: TeamRow<T>[]
  /** `6 working, 1 needs you`; null for a row without lanes. */
  summary: string | null
  /** A lane whose coordinator has ended. */
  orphaned: boolean
}

/** Needs you first, waiting longest first; the rest keep their order. */
function compareRows<T extends TeamMember>(a: TeamRow<T>, b: TeamRow<T>): number {
  const aw = a.group === 'needs-you'
  const bw = b.group === 'needs-you'
  if (aw !== bw) return aw ? -1 : 1
  return aw ? sortAt(a) - sortAt(b) : 0
}

/** A team in Needs you because of a lane sorts by that lane's wait. */
function sortAt<T extends TeamMember>(row: TeamRow<T>): number {
  if (row.group === 'needs-you' && row.item.group !== 'needs-you') {
    const waits = row.children.filter((c) => c.group === 'needs-you').map(sortAt)
    if (waits.length) return Math.min(...waits)
  }
  return row.item.at ?? 0
}

/** One line for a coordinator row: `6 working, 1 needs you, 2 idle`. No
 * finished count; sessions with no status are left out. */
export function teamSummary(
  children: readonly { group: TeamGroup; kind?: TeamMember['kind'] }[],
): string {
  const count = (groups: TeamGroup[]) => children.filter((c) => groups.includes(c.group)).length
  const counts = [
    [count(['working']), 'working'],
    [count(['needs-you']), 'needs you'],
    [count(['idle', 'finished']), 'idle'],
  ] as const
  const parts = counts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${n > 1 && word === 'needs you' ? 'need you' : word}`)
  if (parts.length) return parts.join(', ')
  const noun = children.every((c) => c.kind === 'run') ? 'run' : 'session'
  return children.length === 1 ? `1 ${noun}` : `${children.length} ${noun}s`
}

/** Fold sessions into teams. Input order is kept outside Needs you. */
export function foldTeams<T extends TeamMember>(items: readonly T[]): TeamRow<T>[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  // A lane's parent is its coordinator when listed; a loop in the lineage
  // leaves the session at the top level rather than lose it.
  const parentOf = (item: T): string | null => {
    const parent = item.coordinatorId
    if (!parent || parent === item.id || !byId.has(parent)) return null
    const seen = new Set([item.id])
    for (let at: string | null = parent; at; ) {
      if (seen.has(at)) return null
      seen.add(at)
      const up: T | undefined = byId.get(at)
      at = up?.coordinatorId && byId.has(up.coordinatorId) ? up.coordinatorId : null
    }
    return parent
  }
  const lanes = new Map<string, T[]>()
  const top: T[] = []
  for (const item of items) {
    const parent = parentOf(item)
    if (parent) lanes.set(parent, [...(lanes.get(parent) ?? []), item])
    else top.push(item)
  }
  const build = (item: T): TeamRow<T> => {
    const children = (lanes.get(item.id) ?? []).map(build).sort(compareRows)
    const waiting = children.some((c) => c.group === 'needs-you')
    return {
      item,
      group: waiting ? 'needs-you' : item.group,
      children,
      summary: children.length ? (item.summary ?? teamSummary(children)) : null,
      orphaned: !!item.coordinatorId && !byId.has(item.coordinatorId),
    }
  }
  return top.map(build).sort(compareRows)
}

/** Every session in a row and its folded lanes. */
export function teamMembers<T extends TeamMember>(row: TeamRow<T>): T[] {
  return [row.item, ...row.children.flatMap(teamMembers)]
}

/** A lane's title without the project its coordinator already names:
 * `Neri — Matomo pair lead` under `Neri — Daybreak lead` reads
 * `Matomo pair lead`. A lane in another project keeps its full title. */
export function laneTitle(title: string, leadTitle: string): string {
  const project = leadTitle.split(' — ')[0]
  const prefix = `${project} — `
  return project && title.startsWith(prefix) && title.length > prefix.length
    ? title.slice(prefix.length)
    : title
}

export * from './run-text'
