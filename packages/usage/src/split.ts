// Where a provider's recent usage came from, by project. The collectors file each day's use
// under the project folder of the session's working directory (daily.project); here those
// folders are matched to the project registry. Only providers whose sessions leave a working
// directory in their logs (data/usage.json by_project) are split; the others say so. A folder
// no registered project owns keeps its own name.

import config from '../data/usage.json' with { type: 'json' }
import type { Database } from './db'

/** A registered project: the id is the folder name the collectors file its use under. */
export interface ProjectRef {
  id: string
  name: string
}

export interface ProjectShare {
  /** The registry id for a project, the folder name for one that is not (anymore) registered; null for the grouped rows. */
  id: string | null
  name: string
  kind: 'project' | 'folder' | 'private' | 'unknown' | 'rest'
  amount: number
  /** 0..1 of the total. */
  share: number
}

export interface ProjectSplit {
  /** False: this provider's use is not tracked by project (nothing else here is meaningful). */
  tracked: boolean
  /** What the amounts count (the same unit as the provider's spend per day); null: nothing recorded. */
  unit: 'credits' | 'tokens' | null
  /** The local days counted, first and last. */
  from: string
  to: string
  total: number
  items: ProjectShare[]
}

const UNTRACKED = { unit: null, total: 0, items: [] as ProjectShare[] }

/** Whether the provider's use is split by project. */
const trackedByProject = (provider: string): boolean =>
  config.providers.some(
    (entry) => entry.id === provider && (entry as { by_project?: boolean }).by_project === true,
  )

/** The provider's use over `days` (oldest first), per project, biggest first. */
export function projectSplit(
  db: Database,
  provider: string,
  unit: 'credits' | 'tokens' | null,
  days: string[],
  projects?: readonly ProjectRef[],
): ProjectSplit {
  const from = days[0] as string
  const to = days.at(-1) as string
  if (!trackedByProject(provider)) return { tracked: false, from, to, ...UNTRACKED }
  if (!unit) return { tracked: true, from, to, ...UNTRACKED }
  const rows = db
    .prepare(
      `SELECT project,
              ${unit === 'credits' ? 'SUM(credits_drawn)' : 'SUM(input_tokens + cache_write_tokens + output_tokens)'} AS amount
         FROM daily WHERE provider = ? AND day >= ? AND day <= ? GROUP BY project`,
    )
    .all(provider, from, to) as unknown as { project: string; amount: number }[]
  const named = new Map((projects ?? []).map((p) => [p.id.toLowerCase(), p]))
  const picked = new Map<string, ProjectShare>()
  const add = (key: string, make: () => Omit<ProjectShare, 'amount' | 'share'>, amount: number) => {
    const found = picked.get(key) ?? { ...make(), amount: 0, share: 0 }
    found.amount += amount
    picked.set(key, found)
  }
  for (const row of rows) {
    if (!(row.amount > 0)) continue
    const key = row.project.toLowerCase()
    const ref = named.get(key)
    if (key === 'private')
      add('private', () => ({ id: null, name: 'Private work', kind: 'private' }), row.amount)
    else if (key === 'unknown')
      add('unknown', () => ({ id: null, name: 'Unknown folder', kind: 'unknown' }), row.amount)
    else if (ref) add(key, () => ({ id: ref.id, name: ref.name, kind: 'project' }), row.amount)
    // A folder no registered project owns (a retired project, a scratch folder) keeps its name.
    else add(key, () => ({ id: row.project, name: row.project, kind: 'folder' }), row.amount)
  }
  const total = [...picked.values()].reduce((sum, item) => sum + item.amount, 0)
  const sorted = [...picked.values()]
    .map((item) => ({ ...item, share: total > 0 ? item.amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount)
  const top = config.project_split.top
  const shown = sorted.slice(0, top)
  const rest = sorted.slice(top)
  if (rest.length) {
    const amount = rest.reduce((sum, item) => sum + item.amount, 0)
    shown.push({
      id: null,
      name: `${rest.length} more`,
      kind: 'rest',
      amount,
      share: total > 0 ? amount / total : 0,
    })
  }
  const round = (value: number) => Math.round(value * 10) / 10
  return {
    tracked: true,
    unit,
    from,
    to,
    total: round(total),
    items: shown.map((item) => ({ ...item, amount: round(item.amount) })),
  }
}
