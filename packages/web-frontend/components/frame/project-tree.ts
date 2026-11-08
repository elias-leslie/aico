// The side's Projects section as data: live sessions under their project, the
// projects with nothing running folded into one closing line. Pure; the
// section hands in what it has read and says plainly what it has not. Nothing
// here orders by state: projects run by name and sessions stay oldest first, so
// a state change never moves a row.

import type { ProjectSummary } from '@/lib/projects'
import type { TeamEntry, TeamRow } from './session-entries'

/** Shown under a project with no name to give it. */
const NO_PROJECT_ID = ''
export const NO_PROJECT_NAME = 'No project'

export interface ProjectGroup {
  id: string
  name: string
  /** Its listed sessions, each in its place (a coordinator carries its team). */
  teams: TeamRow<TeamEntry>[]
}

export interface QuietProject {
  id: string
  name: string
  /** Its last activity, in ms; 0 when it has none. */
  at: number
}

export interface ProjectTree {
  groups: ProjectGroup[]
  /** null: the project list has not been read, so who is quiet is not known. */
  quiet: QuietProject[] | null
}

const time = (value: string | null | undefined): number => {
  const ms = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(ms) ? 0 : ms
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name)

/** The project a top-level session belongs to: the one it runs in, else none. */
function projectIdOf(row: TeamRow<TeamEntry>): string {
  const { slot } = row.item.entry
  return (
    slot.projectKey ??
    (slot.type === 'project' ? slot.projectId : null) ??
    NO_PROJECT_ID
  )
}

/** Teams under the project of their coordinator (or of the session on its own); a lane is not
 * listed again under its own project. Projects by name, sessions in the order they arrive. */
export function buildProjectTree({
  teams,
  projects,
}: {
  teams: readonly TeamRow<TeamEntry>[]
  projects: ProjectSummary[] | null
}): ProjectTree {
  const known = new Map(
    (projects ?? []).map((project) => [project.id, project]),
  )
  const byId = new Map<string, ProjectGroup>()
  for (const row of teams) {
    const id = projectIdOf(row)
    const group = byId.get(id) ?? {
      id,
      name:
        known.get(id)?.name ??
        row.item.entry.slot.projectLabel ??
        (id === NO_PROJECT_ID ? NO_PROJECT_NAME : id),
      teams: [],
    }
    group.teams.push(row)
    byId.set(id, group)
  }
  const groups = [...byId.values()].sort(byName)
  const quiet = projects
    ? projects
        .filter((project) => !project.archived && !byId.has(project.id))
        .map((project) => ({
          id: project.id,
          name: project.name,
          at: time(project.lastActivity),
        }))
        .sort(byName)
    : null
  return { groups, quiet }
}
