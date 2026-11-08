// The side's Projects section as data: live sessions under their project, the
// projects with nothing running folded into one closing line. Pure; the
// section hands in what it has read and says plainly what it has not.

import { groupByProject, type HistorySession } from '@/lib/history'
import type { ProjectSummary } from '@/lib/projects'
import { type TeamEntry, type TeamRow, teamMembers } from './session-entries'

/** Shown under a project with no name to give it. */
const NO_PROJECT_ID = ''
export const NO_PROJECT_NAME = 'No project'

export interface ProjectGroup {
  id: string
  name: string
  /** The latest the project did, in ms: its own last activity or a session's state change. */
  at: number
  /** Live sessions that are working, waiting or idle (a coordinator carries its team). */
  teams: TeamRow<TeamEntry>[]
  /** Sessions whose agent finished and that are still listed. */
  finished: TeamRow<TeamEntry>[]
  /** Conversations that ended today and no running session owns. */
  ended: HistorySession[]
}

export interface QuietProject {
  id: string
  name: string
  at: number
  /** Conversations that ended today. */
  endedToday: number
}

export interface ProjectTree {
  groups: ProjectGroup[]
  /** null: the project list has not been read, so who is quiet is not known. */
  quiet: QuietProject[] | null
}

export const startOfDay = (ms: number): number => {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const time = (value: string | null | undefined): number => {
  const ms = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(ms) ? 0 : ms
}

/** The project a top-level session belongs to: the one it runs in, else none. */
function projectIdOf(row: TeamRow<TeamEntry>): string {
  const { slot } = row.item.entry
  return (
    slot.projectKey ??
    (slot.type === 'project' ? slot.projectId : null) ??
    NO_PROJECT_ID
  )
}

/** Conversations that ended today with a final answer, that no running session owns, by project. */
function endedToday(
  history: HistorySession[] | null,
  owned: ReadonlySet<string>,
  now: number,
): Map<string, HistorySession[]> {
  const day = startOfDay(now)
  const rows = (history ?? [])
    .filter(
      (session) =>
        !session.test &&
        session.outcome === 'completed' &&
        (session.endedAt ?? 0) >= day &&
        !owned.has(session.id),
    )
    .map((session) => ({ session }))
  return new Map(
    groupByProject(rows).map((group) => [
      group.project,
      group.rows.map((row) => row.session),
    ]),
  )
}

/** Teams under the project of their coordinator (or of the session on its own); a lane is not
 * listed again under its own project. Projects by latest activity, sessions working first. */
export function buildProjectTree({
  teams,
  projects,
  history,
  owned,
  now,
}: {
  teams: readonly TeamRow<TeamEntry>[]
  projects: ProjectSummary[] | null
  history: HistorySession[] | null
  /** Conversations a running session owns (they are not "ended"). */
  owned: ReadonlySet<string>
  now: number
}): ProjectTree {
  const known = new Map(
    (projects ?? []).map((project) => [project.id, project]),
  )
  const ended = endedToday(history, owned, now)
  const byId = new Map<string, ProjectGroup>()
  for (const row of teams) {
    const id = projectIdOf(row)
    const project = known.get(id)
    const group = byId.get(id) ?? {
      id,
      name:
        project?.name ??
        row.item.entry.slot.projectLabel ??
        (id === NO_PROJECT_ID ? NO_PROJECT_NAME : id),
      at: time(project?.lastActivity),
      teams: [],
      finished: [],
      ended: ended.get(id) ?? [],
    }
    for (const member of teamMembers(row))
      group.at = Math.max(group.at, member.entry.state?.at ?? 0)
    // A finished team that still has lanes running stays with the live ones.
    if (row.group === 'finished') group.finished.push(row)
    else group.teams.push(row)
    byId.set(id, group)
  }
  const groups = [...byId.values()].sort(
    (a, b) => b.at - a.at || a.name.localeCompare(b.name),
  )
  const quiet = projects
    ? projects
        .filter((project) => !project.archived && !byId.has(project.id))
        .map((project) => ({
          id: project.id,
          name: project.name,
          at: time(project.lastActivity),
          endedToday: ended.get(project.id)?.length ?? 0,
        }))
        .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
    : null
  return { groups, quiet }
}
